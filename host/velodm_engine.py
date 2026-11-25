#!/usr/bin/env python3
"""VeloDM download engine daemon (macOS).

Long-running process (like IDMan.exe) that owns every download, so downloads
continue with Chrome closed. Clients - the Chrome relay (velodm_relay.py) and
the VeloDM Mac app - talk to it over a Unix socket using newline-delimited
JSON. Two download engines:

* SegmentedDownload - IDM-style accelerator for direct file URLs: splits the
  file into N byte ranges fetched in parallel, re-splits the largest remaining
  range whenever a connection frees up (dynamic segmentation), and persists
  state so pause/resume and Chrome restarts continue where they left off.
* YtDlpDownload - for pages and streams that need extraction or muxing
  (YouTube and ~1800 other sites, HLS .m3u8, DASH .mpd). Delegates to yt-dlp
  with the browser's cookies, merges with ffmpeg.

Protocol: one JSON object per line on ~/Library/Application Support/VeloDM/engine.sock.
Requests carry {"cmd": ..., "rid": ...}; replies {"type": "reply", "rid"} go to
the asking client only. Pushes ({"type": "jobs"|"finished"|"failed"}) go to
every client, jobs snapshots at most ~3x/second.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

VERSION = "1.0.0"
HOME = Path.home()
STATE_DIR = HOME / "Library" / "Application Support" / "VeloDM"
STATE_FILE = STATE_DIR / "jobs.json"
SETTINGS_FILE = STATE_DIR / "settings.json"
LOG_FILE = STATE_DIR / "engine.log"
SOCK_PATH = STATE_DIR / "engine.sock"

DEFAULT_SETTINGS = {
    "downloadDir": str(HOME / "Downloads"),
    "connections": 8,            # parallel connections per file
    "maxActive": 3,              # concurrent jobs
    "minSegment": 1 << 20,       # don't split below 1 MiB
    "speedLimit": 0,             # bytes/s per job, 0 = unlimited
    "categorize": True,          # Video/, Music/, Compressed/, ... like IDM
}

CATEGORIES = {
    "Video": {"mp4", "mkv", "webm", "mov", "avi", "flv", "m4v", "wmv", "3gp", "ts", "mpg", "mpeg"},
    "Music": {"mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma"},
    "Compressed": {"zip", "rar", "7z", "gz", "tgz", "bz2", "xz", "tar", "dmg", "iso"},
    "Documents": {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "epub", "csv"},
    "Programs": {"pkg", "exe", "msi", "apk", "app", "deb", "rpm"},
}

EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
os.environ["PATH"] = os.pathsep.join(EXTRA_PATH + [os.environ.get("PATH", "")])

STATE_DIR.mkdir(parents=True, exist_ok=True)

VENV = STATE_DIR / "venv"
YTDLP_UPDATE_STAMP = STATE_DIR / "ytdlp-updated"


def ytdlp_bin() -> str | None:
    """VeloDM's private yt-dlp (kept current, with the EJS challenge solver)
    beats a system copy, which may lag behind YouTube's player changes."""
    own = VENV / "bin" / "yt-dlp"
    return str(own) if os.access(own, os.X_OK) else shutil.which("yt-dlp")


def update_ytdlp_loop():
    """YouTube changes its player often; refresh yt-dlp daily (IDM's auto-update equivalent)."""
    while True:
        try:
            age = time.time() - YTDLP_UPDATE_STAMP.stat().st_mtime
        except OSError:
            age = 1e9
        if (VENV / "bin" / "pip").exists() and age > 86400:
            r = subprocess.run([str(VENV / "bin" / "pip"), "install", "-q", "--upgrade", "yt-dlp[default]"],
                               capture_output=True, text=True, timeout=600)
            log("yt-dlp update", "ok" if r.returncode == 0 else r.stderr[-300:])
            if r.returncode == 0:
                YTDLP_UPDATE_STAMP.touch()
        time.sleep(3600)


def is_manifest(url: str) -> bool:
    return bool(re.search(r"\.(m3u8|mpd|f4m)(\?|$)", url, re.I))


def log(*a):
    try:
        with open(LOG_FILE, "a") as f:
            f.write(time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a) + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- io
class Client:
    def __init__(self, conn: socket.socket):
        self.conn = conn
        self.lock = threading.Lock()
        self.alive = True

    def send(self, msg: dict):
        data = json.dumps(msg, separators=(",", ":")).encode() + b"\n"
        if len(data) > 1_000_000:  # Chrome caps host->extension messages at 1 MB
            log("dropping oversized message", msg.get("type"))
            return
        try:
            with self.lock:
                self.conn.sendall(data)
        except OSError:
            self.alive = False


CLIENTS: set[Client] = set()
_clients_lock = threading.Lock()


def send(msg: dict):
    """Broadcast to every connected client."""
    with _clients_lock:
        clients = list(CLIENTS)
    for c in clients:
        c.send(msg)


# --------------------------------------------------------------------- helpers
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def save_json(path: Path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=1))
    tmp.replace(path)


SETTINGS = {**DEFAULT_SETTINGS, **load_json(SETTINGS_FILE, {})}

_BAD = re.compile(r'[\x00-\x1f/\\:*?"<>|]+')


def safe_name(name: str, fallback="download") -> str:
    name = _BAD.sub("_", urllib.parse.unquote(name or "")).strip(" .")
    return (name or fallback)[:200]


def category_dir(filename: str) -> Path:
    base = Path(SETTINGS["downloadDir"]).expanduser()
    if not SETTINGS.get("categorize"):
        return base
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    for cat, exts in CATEGORIES.items():
        if ext in exts:
            return base / cat
    return base


def unique_path(p: Path) -> Path:
    if not p.exists() and not Path(str(p) + ".velodm").exists():
        return p
    stem, suf = p.stem, p.suffix
    for i in range(2, 10000):
        q = p.with_name(f"{stem} ({i}){suf}")
        if not q.exists() and not Path(str(q) + ".velodm").exists():
            return q
    return p.with_name(f"{stem}-{uuid.uuid4().hex[:6]}{suf}")


def filename_from_headers(headers, url: str) -> str:
    cd = headers.get("Content-Disposition", "") or ""
    m = re.search(r"filename\*\s*=\s*[^']*'[^']*'([^;]+)", cd, re.I)
    if m:
        return urllib.parse.unquote(m.group(1).strip().strip('"'))
    m = re.search(r'filename\s*=\s*"?([^";]+)"?', cd, re.I)
    if m:
        return m.group(1).strip()
    return Path(urllib.parse.urlparse(url).path).name


def cookie_header(cookies: list[dict] | None) -> str:
    return "; ".join(f"{c['name']}={c['value']}" for c in (cookies or []))


def write_netscape_cookies(cookies: list[dict] | None) -> str | None:
    if not cookies:
        return None
    fd, path = tempfile.mkstemp(prefix="velodm-cookies-", suffix=".txt", dir=STATE_DIR)
    with os.fdopen(fd, "w") as f:
        f.write("# Netscape HTTP Cookie File\n")
        for c in cookies:
            domain = c.get("domain", "")
            sub = "TRUE" if domain.startswith(".") else "FALSE"
            exp = int(c.get("expirationDate") or 0)
            secure = "TRUE" if c.get("secure") else "FALSE"
            f.write("\t".join([domain, sub, c.get("path", "/"), secure, str(exp), c["name"], c["value"]]) + "\n")
    os.chmod(path, 0o600)
    return path


# ------------------------------------------------------------------------ jobs
class Job:
    kind = "base"

    def __init__(self, d: dict):
        self.id = d.get("id") or uuid.uuid4().hex[:12]
        self.url = d["url"]
        self.page = d.get("page") or d.get("referer") or ""
        self.referer = d.get("referer") or self.page
        self.ua = d.get("userAgent") or ""
        self.headers = d.get("headers") or {}
        self.cookies = d.get("cookies") or []
        self.filename = d.get("filename") or ""
        self.path = d.get("path") or ""
        self.title = d.get("title") or ""
        self.status = d.get("status") or "queued"   # queued|downloading|paused|done|error
        self.size = d.get("size") or 0
        self.done = d.get("done") or 0
        self.speed = 0.0
        self.error = d.get("error") or ""
        self.created = d.get("created") or time.time()
        self.finished = d.get("finished") or 0
        self.thread: threading.Thread | None = None
        self.stop_evt = threading.Event()

    # persisted fields
    def to_dict(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "url": self.url, "page": self.page,
            "referer": self.referer, "userAgent": self.ua, "headers": self.headers,
            "filename": self.filename, "path": self.path, "title": self.title,
            "status": self.status, "size": self.size, "done": self.done,
            "error": self.error, "created": self.created, "finished": self.finished,
        }

    def public(self) -> dict:
        d = self.to_dict()
        d.pop("headers", None)
        d["speed"] = round(self.speed)
        d["eta"] = int((self.size - self.done) / self.speed) if self.speed > 1 and self.size else None
        return d

    def start(self):
        self.stop_evt.clear()
        self.status = "downloading"
        self.error = ""
        self.thread = threading.Thread(target=self._safe_run, daemon=True)
        self.thread.start()

    def _safe_run(self):
        try:
            self.run()
        except Exception as e:  # noqa: BLE001
            if not self.stop_evt.is_set():
                self.status, self.error = "error", str(e) or e.__class__.__name__
                log("job error", self.id, traceback.format_exc())
        finally:
            self.speed = 0
            MANAGER.on_job_finished(self)

    def pause(self):
        self.stop_evt.set()
        if self.status in ("downloading", "queued"):
            self.status = "paused"

    def run(self):
        raise NotImplementedError

    def request_headers(self) -> dict:
        h = {"User-Agent": self.ua or "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Accept": "*/*"}
        if self.referer:
            h["Referer"] = self.referer
        ck = cookie_header(self.cookies)
        if ck:
            h["Cookie"] = ck
        h.update({k: v for k, v in self.headers.items() if k.lower() not in ("range", "host", "content-length")})
        return h


class SegmentedDownload(Job):
    """Multi-connection Range downloader with dynamic segmentation and resume."""

    kind = "direct"

    def __init__(self, d: dict):
        super().__init__(d)
        # each segment: [start, end_inclusive, downloaded]
        self.segments: list[list[int]] = d.get("segments") or []
        self.resumable = d.get("resumable", True)
        self.lock = threading.Lock()

    def to_dict(self):
        d = super().to_dict()
        d["segments"] = self.segments
        d["resumable"] = self.resumable
        return d

    def public(self):
        d = super().public()
        d.pop("segments", None)
        d["parts"] = [[s[0], s[1], s[2]] for s in self.segments][:64]
        d["connections"] = sum(1 for s in self.segments if s[2] < s[1] - s[0] + 1)
        return d

    def _open(self, start=None, end=None):
        h = self.request_headers()
        if start is not None:
            h["Range"] = f"bytes={start}-" + ("" if end is None else str(end))
        return urllib.request.urlopen(urllib.request.Request(self.url, headers=h), timeout=30)

    def probe(self):
        resp = self._open(0, None)
        try:
            cr = resp.headers.get("Content-Range")
            if resp.status == 206 and cr and "/" in cr and cr.split("/")[-1].isdigit():
                self.size = int(cr.split("/")[-1])
                self.resumable = True
            else:
                self.size = int(resp.headers.get("Content-Length") or 0)
                self.resumable = False
            if not self.filename:
                name = filename_from_headers(resp.headers, resp.url)
                if "." not in name:
                    ext = (resp.headers.get_content_type() or "").split("/")[-1]
                    ext = {"mpeg": "mp3", "quicktime": "mov", "x-matroska": "mkv"}.get(ext, ext)
                    if ext and ext not in ("octet-stream", "html", "plain"):
                        name = f"{name or 'download'}.{ext}"
                self.filename = safe_name(name)
            if resp.url != self.url:
                self.url = resp.url  # follow redirects once; segments hit the final URL
        finally:
            resp.close()

    def run(self):
        if not self.segments or not self.path:
            self.probe()
            folder = category_dir(self.filename)
            folder.mkdir(parents=True, exist_ok=True)
            self.path = str(unique_path(folder / self.filename))
            self.filename = Path(self.path).name
            if self.size and self.resumable:
                n = max(1, min(SETTINGS["connections"], self.size // SETTINGS["minSegment"] or 1))
                step = self.size // n
                self.segments = [[i * step, (self.size - 1 if i == n - 1 else (i + 1) * step - 1), 0] for i in range(n)]
            else:
                self.segments = [[0, (self.size - 1) if self.size else -1, 0]]
            MANAGER.persist()

        part = self.path + ".velodm"
        if not os.path.exists(part):
            with open(part, "wb") as f:
                if self.size:
                    f.truncate(self.size)
        if not self.resumable:  # cannot resume: restart from scratch
            self.segments = [[0, (self.size - 1) if self.size else -1, 0]]

        workers: list[threading.Thread] = []
        for idx in range(len(self.segments)):
            if self._remaining(idx) != 0:
                workers.append(self._spawn(idx, part))

        last_done, last_t = self._done_bytes(), time.time()
        while any(w.is_alive() for w in workers):
            time.sleep(0.5)
            now = time.time()
            done = self._done_bytes()
            inst = (done - last_done) / max(now - last_t, 1e-3)
            self.speed = inst if not self.speed else self.speed * 0.7 + inst * 0.3
            last_done, last_t = done, now
            self.done = done
            # dynamic segmentation: keep `connections` busy by splitting the biggest remainder
            alive = sum(1 for w in workers if w.is_alive())
            if self.resumable and self.size and alive < SETTINGS["connections"] and not self.stop_evt.is_set():
                new_idx = self._split_largest()
                if new_idx is not None:
                    workers.append(self._spawn(new_idx, part))
            MANAGER.touch()

        self.done = self._done_bytes()
        if self.stop_evt.is_set():
            return
        errs = [s for s in self.segments if len(s) > 3 and s[3]]
        if self.size and self.done < self.size:
            raise RuntimeError(errs[0][3] if errs else "download incomplete")
        os.replace(part, self.path)
        self.size = self.size or self.done
        self.status, self.finished = "done", time.time()

    def _done_bytes(self):
        with self.lock:
            return sum(s[2] for s in self.segments)

    def _remaining(self, idx):
        s = self.segments[idx]
        if s[1] < 0:
            return -1  # unknown length
        return s[1] - s[0] + 1 - s[2]

    def _split_largest(self):
        with self.lock:
            best, best_rem = None, 0
            for i, s in enumerate(self.segments):
                rem = s[1] - s[0] + 1 - s[2]
                if rem > best_rem:
                    best, best_rem = i, rem
            if best is None or best_rem < 2 * SETTINGS["minSegment"]:
                return None
            s = self.segments[best]
            cur = s[0] + s[2]
            mid = cur + best_rem // 2
            self.segments.append([mid, s[1], 0])
            s[1] = mid - 1
            return len(self.segments) - 1

    def _spawn(self, idx, part):
        t = threading.Thread(target=self._worker, args=(idx, part), daemon=True)
        t.start()
        return t

    def _worker(self, idx, part):
        retries = 0
        while not self.stop_evt.is_set():
            seg = self.segments[idx]
            if seg[1] >= 0 and seg[0] + seg[2] > seg[1]:
                return
            try:
                if self.resumable:
                    resp = self._open(seg[0] + seg[2], seg[1] if seg[1] >= 0 else None)
                    if resp.status != 206:
                        raise RuntimeError(f"server ignored Range (HTTP {resp.status})")
                else:
                    seg[2] = 0
                    resp = self._open()
                with resp, open(part, "r+b") as f:
                    f.seek(seg[0] + seg[2])
                    limit = SETTINGS.get("speedLimit") or 0
                    t0, got0 = time.time(), 0
                    while not self.stop_evt.is_set():
                        with self.lock:
                            end = seg[1]  # may shrink when another worker steals the tail
                        want = 256 * 1024
                        if end >= 0:
                            want = min(want, end - (seg[0] + seg[2]) + 1)
                            if want <= 0:
                                return
                        chunk = resp.read(want)
                        if not chunk:
                            if end < 0:
                                return
                            raise RuntimeError("connection closed early")
                        f.write(chunk)
                        with self.lock:
                            seg[2] += len(chunk)
                        retries = 0
                        if limit:
                            got0 += len(chunk)
                            per_conn = limit / max(1, len(self.segments))
                            ahead = got0 / per_conn - (time.time() - t0)
                            if ahead > 0:
                                time.sleep(ahead)
                return
            except (urllib.error.URLError, OSError, RuntimeError) as e:
                retries += 1
                if retries > 6 or (isinstance(e, urllib.error.HTTPError) and e.code in (401, 403, 404, 410)):
                    while len(seg) < 4:
                        seg.append("")
                    seg[3] = str(e)
                    return
                time.sleep(min(2 ** retries, 20))


_PROG = re.compile(r"^VELO (\S+) (\S+) (\S+) (\S+) (\S+)$")


class YtDlpDownload(Job):
    """Site extraction (YouTube etc.), HLS and DASH via yt-dlp + ffmpeg."""

    kind = "ytdlp"

    def __init__(self, d: dict):
        super().__init__(d)
        self.format = d.get("format") or "bv*+ba/b"
        self.audio_only = bool(d.get("audioOnly"))
        self.proc: subprocess.Popen | None = None
        self.stage = ""

    def to_dict(self):
        d = super().to_dict()
        d.update(format=self.format, audioOnly=self.audio_only)
        return d

    def public(self):
        d = super().public()
        d["stage"] = self.stage
        return d

    def pause(self):
        super().pause()
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)

    def run(self):
        # Signed-in cookies make yt-dlp use YouTube's web clients, which are the
        # first to break when YouTube changes; retry anonymously before giving up.
        try:
            self.run_once(use_cookies=bool(self.cookies))
        except RuntimeError as e:
            if not self.cookies or self.stop_evt.is_set():
                raise
            log("yt-dlp failed with cookies, retrying without:", e)
            self.run_once(use_cookies=False)

    def run_once(self, use_cookies: bool):
        ytdlp = ytdlp_bin()
        if not ytdlp:
            raise RuntimeError("yt-dlp not installed (run install.sh)")
        base = Path(SETTINGS["downloadDir"]).expanduser()
        folder = base / ("Music" if self.audio_only else "Video") if SETTINGS.get("categorize") else base
        folder.mkdir(parents=True, exist_ok=True)
        cookie_file = write_netscape_cookies(self.cookies) if use_cookies else None
        tmpl = (safe_name(Path(self.filename).stem) + ".%(ext)s") if self.filename else "%(title).180B [%(id)s].%(ext)s"
        cmd = [
            ytdlp, "--newline", "--no-playlist", "--no-colors", "--no-mtime",
            "-N", str(min(8, SETTINGS["connections"])),
            "--progress-template",
            "download:VELO %(progress.downloaded_bytes)s %(progress.total_bytes)s "
            "%(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
            "--print", "after_move:VELOFILE %(filepath)s",
            "-P", str(folder), "-o", tmpl,
        ]
        if self.audio_only:
            cmd += ["-f", self.format if self.format != "bv*+ba/b" else "ba/b", "-x", "--audio-format", "mp3"]
        else:
            cmd += ["-f", self.format, "-S", "res,fps,ext:mp4:m4a", "--merge-output-format", "mp4/mkv"]
        # Site extractors (YouTube…) pick their own client headers; a browser
        # User-Agent would override them. Only raw manifests need the page's.
        if is_manifest(self.url):
            if self.referer:
                cmd += ["--referer", self.referer]
            if self.ua:
                cmd += ["--user-agent", self.ua]
        for k, v in self.headers.items():
            if k.lower() not in ("cookie", "referer", "user-agent", "range"):
                cmd += ["--add-header", f"{k}:{v}"]
        if cookie_file:
            cmd += ["--cookies", cookie_file]
        if SETTINGS.get("speedLimit"):
            cmd += ["-r", str(SETTINGS["speedLimit"])]
        cmd.append(self.url)
        log("yt-dlp", " ".join(cmd[:3]), self.url)

        tail: list[str] = []
        streams_done, prev_total = 0, 0
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                         text=True, bufsize=1, start_new_session=True)
            for line in self.proc.stdout:
                line = line.rstrip()
                m = _PROG.match(line)
                if m:
                    dl, tot, est, spd, _eta = m.groups()
                    num = lambda s: float(s) if s not in ("NA", "None") else 0.0  # noqa: E731
                    total = num(tot) or num(est)
                    if total and prev_total and abs(total - prev_total) > 0.2 * prev_total and num(dl) < 0.05 * total:
                        streams_done += prev_total   # yt-dlp moved on to the next stream (audio after video)
                    prev_total = total or prev_total
                    self.done = int(streams_done + num(dl))
                    self.size = int(streams_done + total) if total else self.size
                    self.speed = num(spd)
                    self.stage = "downloading"
                    MANAGER.touch()
                    continue
                if line.startswith("VELOFILE "):
                    self.path = line[9:].strip()
                    self.filename = Path(self.path).name
                elif "[Merger]" in line or "[ExtractAudio]" in line or "[FixupM3u8]" in line:
                    self.stage = "merging"
                    MANAGER.touch()
                elif line.startswith("[download] Destination:") and not self.title:
                    self.filename = Path(line.split(":", 1)[1].strip()).name
                tail = (tail + [line])[-15:]
            rc = self.proc.wait()
        finally:
            if cookie_file:
                try:
                    os.unlink(cookie_file)
                except OSError:
                    pass
        if self.stop_evt.is_set():
            return
        if rc != 0:
            errs = [l for l in tail if "ERROR" in l]
            raise RuntimeError((errs[-1] if errs else (tail[-1] if tail else f"yt-dlp exited {rc}"))[:400])
        if self.path and os.path.exists(self.path):
            self.size = self.done = os.path.getsize(self.path)
        self.status, self.finished, self.stage = "done", time.time(), ""


# ---------------------------------------------------------------------- manager
class Manager:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self.lock = threading.RLock()
        self.dirty = threading.Event()
        self.shutting_down = False
        for d in load_json(STATE_FILE, []):
            try:
                j = (YtDlpDownload if d.get("kind") == "ytdlp" else SegmentedDownload)(d)
                if j.status in ("downloading", "queued"):
                    j.status = "queued"   # resume after restart
                self.jobs[j.id] = j
            except (KeyError, TypeError):
                continue

    def persist(self):
        with self.lock:
            save_json(STATE_FILE, [j.to_dict() for j in self.jobs.values()])

    def touch(self):
        self.dirty.set()

    def snapshot(self):
        with self.lock:
            return sorted((j.public() for j in self.jobs.values()), key=lambda d: -d["created"])

    def add(self, d: dict) -> Job:
        use_ytdlp = d.get("engine") == "ytdlp" or (
            d.get("engine") != "direct" and re.search(r"\.(m3u8|mpd)(\?|$)", d["url"], re.I))
        j = (YtDlpDownload if use_ytdlp else SegmentedDownload)({**d, "id": None, "status": "queued"})
        with self.lock:
            self.jobs[j.id] = j
        self.schedule()
        return j

    def schedule(self):
        if self.shutting_down:
            return
        with self.lock:
            active = sum(1 for j in self.jobs.values() if j.thread and j.thread.is_alive())
            for j in sorted(self.jobs.values(), key=lambda j: j.created):
                if active >= SETTINGS["maxActive"]:
                    break
                if j.status == "queued" and not (j.thread and j.thread.is_alive()):
                    j.start()
                    active += 1
        self.persist()
        self.touch()

    def on_job_finished(self, job: Job):
        if job.status == "done":
            send({"type": "finished", "job": job.public()})
        elif job.status == "error":
            send({"type": "failed", "job": job.public()})
        self.schedule()

    def pusher(self):
        while True:
            self.dirty.wait()
            self.dirty.clear()
            send({"type": "jobs", "jobs": self.snapshot()})
            time.sleep(0.33)

    def saver(self):
        while True:
            time.sleep(5)
            if any(j.status == "downloading" for j in list(self.jobs.values())):
                self.persist()


MANAGER: Manager


# ---------------------------------------------------------------------- probing
def probe(url: str, cookies, referer="", ua=""):
    """Ask yt-dlp what formats a page/stream offers (resolutions, audio tracks)."""
    ytdlp = ytdlp_bin()
    if not ytdlp:
        return {"error": "yt-dlp not installed (run install.sh)"}
    r = _probe_run(ytdlp, url, cookies, referer, ua)
    if cookies and r.returncode == 0 and not _has_video(r.stdout):
        r.returncode = 1
        r.stderr = "ERROR: signed-in request returned no playable formats"
    if r.returncode != 0 and cookies:
        log("probe failed with cookies, retrying without:", _err(r))
        r = _probe_run(ytdlp, url, None, referer, ua)
    if r.returncode != 0:
        log("probe failed:", url, _err(r))
        return {"error": _err(r)}
    info = json.loads(r.stdout)
    fmts = []
    for f in info.get("formats") or []:
        if f.get("format_id", "").startswith("sb") or f.get("vcodec") == "none" and f.get("acodec") == "none":
            continue  # storyboards / junk
        fmts.append({
            "id": f.get("format_id"), "ext": f.get("ext"), "height": f.get("height"),
            "fps": f.get("fps"), "vcodec": f.get("vcodec"), "acodec": f.get("acodec"),
            "size": f.get("filesize") or f.get("filesize_approx"), "tbr": f.get("tbr"),
            "note": f.get("format_note") or "", "proto": f.get("protocol"),
        })
    return {
        "title": info.get("title"), "id": info.get("id"), "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"), "extractor": info.get("extractor_key"),
        "uploader": info.get("uploader"), "formats": fmts,
    }


def _has_video(out: str) -> bool:
    try:
        return any((f.get("vcodec") or "none") != "none" or (f.get("acodec") or "none") != "none"
                   for f in json.loads(out).get("formats") or [] if not str(f.get("format_id", "")).startswith("sb"))
    except ValueError:
        return False


def _err(r) -> str:
    if isinstance(r, subprocess.TimeoutExpired):
        return "timed out asking the site for formats"
    err = [l for l in (r.stderr or "").splitlines() if "ERROR" in l]
    return (err[-1] if err else (r.stderr or "").strip()[-300:]) or "unsupported URL"


def _probe_run(ytdlp, url, cookies, referer, ua):
    cookie_file = write_netscape_cookies(cookies)
    cmd = [ytdlp, "-J", "--no-playlist", "--no-warnings"]
    if cookie_file:
        cmd += ["--cookies", cookie_file]
    if is_manifest(url):
        if referer:
            cmd += ["--referer", referer]
        if ua:
            cmd += ["--user-agent", ua]
    cmd.append(url)
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired as e:
        e.returncode, e.stderr = 1, "ERROR: timed out asking the site for formats"
        return e
    finally:
        if cookie_file:
            os.unlink(cookie_file)


# ----------------------------------------------------------------------- server
def handle(msg: dict, client: Client):
    cmd, rid = msg.get("cmd"), msg.get("rid")
    reply = lambda **kw: client.send({"type": "reply", "rid": rid, **kw})  # noqa: E731
    jobs = MANAGER.jobs
    if cmd == "hello":
        reply(version=VERSION, pid=os.getpid(), ytdlp=bool(ytdlp_bin()), ffmpeg=bool(shutil.which("ffmpeg")),
              settings=SETTINGS, jobs=MANAGER.snapshot())
    elif cmd == "download":
        j = MANAGER.add(msg)
        reply(ok=True, id=j.id)
    elif cmd == "probe":
        def work():
            reply(**probe(msg["url"], msg.get("cookies"), msg.get("referer", ""), msg.get("userAgent", "")))
        threading.Thread(target=work, daemon=True).start()
    elif cmd in ("pause", "resume", "cancel", "remove", "redownload"):
        j = jobs.get(msg.get("id"))
        if not j:
            return reply(ok=False, error="no such job")
        if cmd == "pause":
            j.pause()
        elif cmd == "resume" and j.status in ("paused", "error"):
            j.status = "queued"
        elif cmd in ("cancel", "remove", "redownload"):
            j.pause()
            if j.thread:
                j.thread.join(timeout=5)
            if cmd == "cancel" or j.status != "done" or msg.get("deleteFile"):
                for p in (j.path + ".velodm" if j.path else "", j.path if msg.get("deleteFile") else ""):
                    if p and os.path.exists(p):
                        os.unlink(p)
            if cmd == "redownload":
                MANAGER.add({**j.to_dict(), "segments": None, "path": None, "cookies": j.cookies,
                             "engine": "ytdlp" if j.kind == "ytdlp" else "direct"})
            with MANAGER.lock:
                jobs.pop(j.id, None)
        MANAGER.schedule()
        reply(ok=True)
    elif cmd == "pauseAll":
        for j in list(jobs.values()):
            j.pause()
        MANAGER.schedule()
        reply(ok=True)
    elif cmd == "resumeAll":
        for j in list(jobs.values()):
            if j.status in ("paused", "error"):
                j.status = "queued"
        MANAGER.schedule()
        reply(ok=True)
    elif cmd == "clearDone":
        with MANAGER.lock:
            for k in [k for k, j in jobs.items() if j.status == "done"]:
                jobs.pop(k)
        MANAGER.schedule()
        reply(ok=True)
    elif cmd in ("open", "reveal"):
        j = jobs.get(msg.get("id"))
        target = (j.path if j else "") or SETTINGS["downloadDir"]
        if cmd == "reveal" and os.path.exists(target):
            subprocess.Popen(["open", "-R", target])
        else:
            subprocess.Popen(["open", target if os.path.exists(target) else SETTINGS["downloadDir"]])
        reply(ok=True)
    elif cmd == "settings":
        upd = {k: v for k, v in (msg.get("set") or {}).items() if k in DEFAULT_SETTINGS}
        SETTINGS.update(upd)
        save_json(SETTINGS_FILE, SETTINGS)
        reply(settings=SETTINGS)
    elif cmd == "list":
        reply(jobs=MANAGER.snapshot())
    elif cmd == "quit":
        reply(ok=True)
        shutdown()
    else:
        reply(error=f"unknown cmd {cmd!r}")


def serve_client(conn: socket.socket):
    c = Client(conn)
    with _clients_lock:
        CLIENTS.add(c)
    c.send({"type": "jobs", "jobs": MANAGER.snapshot()})
    buf = b""
    try:
        while c.alive:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                msg = {}
                try:
                    msg = json.loads(line)
                    handle(msg, c)
                except Exception as e:  # noqa: BLE001
                    log("handle error", traceback.format_exc())
                    c.send({"type": "reply", "rid": msg.get("rid") if isinstance(msg, dict) else None, "error": str(e)})
    except OSError:
        pass
    finally:
        with _clients_lock:
            CLIENTS.discard(c)
        conn.close()


def shutdown():
    """Pause cleanly so every job resumes on next start."""
    MANAGER.shutting_down = True
    for j in list(MANAGER.jobs.values()):
        if j.status == "downloading":
            j.stop_evt.set()
            if isinstance(j, YtDlpDownload) and j.proc and j.proc.poll() is None:
                j.proc.send_signal(signal.SIGINT)
            j.status = "queued"
    time.sleep(1)
    MANAGER.persist()
    try:
        SOCK_PATH.unlink()
    except OSError:
        pass
    os._exit(0)


def already_running() -> bool:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(str(SOCK_PATH))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main():
    global MANAGER
    if already_running():
        print("engine already running")
        return
    try:
        SOCK_PATH.unlink()
    except OSError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(str(SOCK_PATH))
    os.chmod(SOCK_PATH, 0o600)
    srv.listen(16)
    MANAGER = Manager()
    threading.Thread(target=MANAGER.pusher, daemon=True).start()
    threading.Thread(target=MANAGER.saver, daemon=True).start()
    threading.Thread(target=update_ytdlp_loop, daemon=True).start()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: threading.Thread(target=shutdown).start())
    MANAGER.schedule()
    log("engine started", VERSION, os.getpid())
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=serve_client, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
