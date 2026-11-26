// VeloDM content script: modifier-key tracking and the floating
// "Download this video" button over players.
(() => {
  if (window.__velodm) return;
  window.__velodm = true;

  const send = (m) => chrome.runtime.sendMessage(m).catch(() => null);

  // ---- modifier keys at click time (Alt = let Chrome handle, Shift+Alt = force VeloDM)
  addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !e.target.closest?.("a[href]")) return;
    if (e.altKey && e.shiftKey) send({ cmd: "modifier", mode: "force" });
    else if (e.altKey) send({ cmd: "modifier", mode: "bypass" });
  }, true);

  // ---- floating panel
  let enabled = true;
  chrome.storage.local.get({ panel: true }, (s) => { enabled = s.panel; });
  chrome.storage.onChanged.addListener((c) => { if (c.panel) enabled = c.panel.newValue; });

  let hostEl, root, btn, menu, current = null, hideTimer = null;

  function ensureUI() {
    if (hostEl) return;
    hostEl = document.createElement("velodm-panel");
    hostEl.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;";
    root = hostEl.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all: initial; }
      .b { position: fixed; display: none; align-items: center; gap: 6px; padding: 6px 10px 6px 8px; border-radius: 8px;
           background: rgba(20,24,30,.88); color: #fff; font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif;
           cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.35); user-select: none; backdrop-filter: blur(6px); }
      .b:hover { background: #1f6feb; }
      .b svg { width: 16px; height: 16px; }
      .b .x { margin-left: 4px; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
              border-radius: 50%; font-size: 15px; line-height: 1; opacity: .75; }
      .b .x:hover { opacity: 1; background: rgba(255,255,255,.22); }
      .m { position: fixed; display: none; min-width: 220px; max-width: 320px; max-height: 60vh; overflow: auto; padding: 6px;
           background: #1b1f24; color: #e6e9ed; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
           font: 13px/1.3 -apple-system, BlinkMacSystemFont, sans-serif; }
      .m .h { padding: 6px 8px; color: #95a0ad; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .m button { all: unset; display: flex; justify-content: space-between; gap: 12px; width: calc(100% - 16px); padding: 7px 8px;
                  border-radius: 6px; cursor: pointer; }
      .m button:hover { background: #1f6feb; color: #fff; }
      .m small { opacity: .65; flex: none; }
      .m .l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    </style>
    <div class="b" part="b"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg><span class="lbl">Download video</span><span class="x" role="button" title="Hide for this video" aria-label="Close">×</span></div>
    <div class="m"></div>`;
    btn = root.querySelector(".b");
    menu = root.querySelector(".m");
    btn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    btn.addEventListener("mouseleave", scheduleHide);
    menu.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    menu.addEventListener("mouseleave", scheduleHide);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.target.closest?.(".x")) return dismiss();
      openMenu();
    });
    document.documentElement.append(hostEl);
  }

  function visibleRect(v) {
    const r = v.getBoundingClientRect();
    const x1 = Math.max(r.left, 0), y1 = Math.max(r.top, 0);
    const x2 = Math.min(r.right, innerWidth), y2 = Math.min(r.bottom, innerHeight);
    return x2 - x1 > 0 && y2 - y1 > 0 ? { left: x1, top: y1, right: x2, bottom: y2, w: r.width, h: r.height } : null;
  }

  function place() {
    if (!current) return;
    const r = visibleRect(current);
    if (!r || r.w < 200 || r.h < 110) return hide();
    btn.style.display = "flex";
    btn.style.left = Math.max(4, r.right - btn.offsetWidth - 10) + "px";
    btn.style.top = Math.max(4, r.top + 10) + "px";
  }

  // × hides the button for this video. YouTube reuses one <video> element
  // across videos, so the dismissal is tied to the element *and* the page URL.
  const dismissed = new WeakMap();
  function dismiss() {
    if (current) dismissed.set(current, location.href);
    menu.style.display = "none";
    btn.style.display = "none";
    current = null;
  }

  function show(v) {
    if (!enabled || dismissed.get(v) === location.href) return;
    ensureUI();
    clearTimeout(hideTimer);
    if (current !== v) { current = v; menu.style.display = "none"; }
    place();
  }
  function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 900); }
  function hide() {
    if (!btn) return;
    if (menu.style.display === "block") return;
    btn.style.display = "none";
    current = null;
  }

  // Detect the player under the pointer. Players overlay controls on the
  // <video>, so test geometry rather than relying on the event target.
  let lastMove = 0;
  addEventListener("mousemove", (e) => {
    const now = performance.now();
    if (now - lastMove < 120) return;
    lastMove = now;
    if (hostEl && e.composedPath().includes(hostEl)) return;
    let found = null;
    for (const v of document.querySelectorAll("video, audio[controls]")) {
      const r = v.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && r.width >= 200) {
        found = v;
        break;
      }
    }
    if (found) show(found);
    else if (current) scheduleHide();
  }, { passive: true, capture: true });
  addEventListener("scroll", place, { passive: true, capture: true });
  addEventListener("resize", place, { passive: true });
  addEventListener("fullscreenchange", () => {
    // keep the panel visible in fullscreen players
    if (!hostEl) return;
    (document.fullscreenElement || document.documentElement).append(hostEl);
  });
  document.addEventListener("click", (e) => {
    if (menu && menu.style.display === "block" && !e.composedPath().includes(hostEl)) { menu.style.display = "none"; hide(); }
  }, true);

  function item(label, sub, onClick) {
    const b = document.createElement("button");
    const l = document.createElement("span");
    l.className = "l";
    l.textContent = label;
    b.title = label;
    b.append(l);
    if (sub) { const s = document.createElement("small"); s.textContent = sub; b.append(s); }
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); menu.style.display = "none"; hide(); });
    return b;
  }
  function header(t) { const d = document.createElement("div"); d.className = "h"; d.textContent = t; return d; }
  const fmtB = (n) => !n ? "" : n > 1 << 30 ? (n / (1 << 30)).toFixed(2) + " GB" : (n / (1 << 20)).toFixed(n > 100 << 20 ? 0 : 1) + " MB";

  async function openMenu() {
    const r = btn.getBoundingClientRect();
    menu.style.display = "block";
    menu.style.top = r.bottom + 6 + "px";
    menu.style.left = Math.max(8, Math.min(r.right - 260, innerWidth - 330)) + "px";
    menu.replaceChildren(header("Finding qualities…"));

    const page = location.href;
    const src = current?.currentSrc || current?.src || "";
    const streams = (await send({ cmd: "tabMedia" })) || [];
    // Try the page itself and any embedded player (Wistia, Vimeo, YouTube…).
    // On sites yt-dlp doesn't know (course platforms etc.) the embed is what works.
    const embeds = [...new Set([...embedsInDocument(), ...streams.filter((s) => s.kind === "embed").map((s) => s.url)])];
    const known = await send({ cmd: "isVideoPage", url: page });
    const candidates = known ? [page, ...embeds] : [...embeds, page];
    let info = null, url = page;
    for (const c of candidates) {
      menu.replaceChildren(header(c === page ? "Finding qualities…" : "Checking embedded player…"));
      const r = await send({ cmd: "probe", url: c, referer: page });
      if (r && !r.error && r.formats?.length) { info = r; url = c; break; }
      if (!info) info = r;   // keep the first error to show
    }
    // Embedded players often carry a meaningless title (Wistia: the uploaded
    // file's name); name the file after the page/lesson instead.
    let filename;
    if (url !== page && document.title.trim() && (!info?.title || /^[\w-]{12,}(\.\w{2,4})?$/.test(info.title))) {
      filename = document.title.trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 150) + ".mp4";
    }
    const dl = (extra) => send({ cmd: "download", url, engine: "ytdlp", page, referer: page, title: info?.title, filename, ...extra });
    const kids = [];
    if (info && !info.error && info.formats?.length) {
      kids.push(header(info.title || document.title));
      const byH = new Map();
      for (const f of info.formats) {
        if (!f.height || f.vcodec === "none") continue;
        const c = byH.get(f.height);
        if (!c || (f.ext === "mp4") > (c.ext === "mp4") || (f.tbr || 0) > (c.tbr || 0)) byH.set(f.height, f);
      }
      const audio = info.formats.filter((f) => f.vcodec === "none" && f.acodec !== "none").sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
      for (const f of [...byH.values()].sort((a, b) => b.height - a.height)) {
        const size = (f.size || 0) + (f.acodec && f.acodec !== "none" ? 0 : audio?.size || 0);
        kids.push(item(`${f.height}p${f.fps > 30 ? f.fps : ""}`, fmtB(size) || f.ext,
          () => dl({ format: `bv*[height=${f.height}]+ba/b[height=${f.height}]/b` })));
      }
      if (!byH.size) kids.push(item("Best quality", "", () => dl({})));
      if (audio) kids.push(item("Audio only (MP3)", fmtB(audio.size), () => dl({ audioOnly: true })));
    }
    const sniffed = streams.filter((s) => s.kind !== "embed" && (s.kind !== "file" || s.size));
    if (sniffed.length) {
      kids.push(header("Streams seen on this page"));
      for (const s of sniffed.slice(0, 8)) {
        kids.push(item(s.filename || s.kind.toUpperCase() + " stream", fmtB(s.size) || s.kind.toUpperCase(),
          () => send({ cmd: "download", url: s.url, engine: s.kind === "file" ? "direct" : "ytdlp", page })));
      }
    }
    if (/^https?:/.test(src) && !kids.length) {
      kids.push(header("Video file"));
      kids.push(item(decodeURIComponent(src.split(/[?#]/)[0].split("/").pop()) || "This video", "", () => send({ cmd: "download", url: src, engine: "direct", page })));
    }
    if (!kids.length) {
      kids.push(header(info?.error ? "Couldn't get this video:" : "VeloDM helper not connected"));
      if (info?.error) {
        const e = document.createElement("div");
        e.className = "h";
        e.style.whiteSpace = "normal";
        e.textContent = info.error.replace(/^ERROR:\s*/, "").slice(0, 300);
        kids.push(e);
      }
    }
    menu.replaceChildren(...kids);
  }

  // Player embeds referenced in this document.
  function embedsInDocument() {
    const out = new Set();
    const wistia = (id) => out.add(`https://fast.wistia.net/embed/iframe/${id}`);
    for (const k of ["wvideo", "wmediaid", "wistia_media_id"]) {
      const v = new URLSearchParams(location.search).get(k);
      if (v && /^[a-z0-9]{10}$/i.test(v)) wistia(v);
    }
    for (const e of document.querySelectorAll('[class*="wistia_async_"], [class*="wistia_embed"]')) {
      const m = String(e.className).match(/wistia_async_([a-z0-9]{10})/i);
      if (m) wistia(m[1]);
    }
    for (const f of document.querySelectorAll("iframe[src]")) {
      const s = f.src;
      let m = s.match(/wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([a-z0-9]{10})/i);
      if (m) { wistia(m[1]); continue; }
      if (/player\.vimeo\.com\/video\/\d+|youtube(?:-nocookie)?\.com\/embed\/[\w-]{11}|dailymotion\.com\/embed\/video\//.test(s)) out.add(s.split("#")[0]);
    }
    return [...out];
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "mediaFound" && current) place();
  });
})();
