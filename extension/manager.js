let jobs = [];
let filter = "all";
let hostSettings = null;
const $ = (id) => document.getElementById(id);

const port = chrome.runtime.connect({ name: "ui" });
port.onMessage.addListener((m) => {
  if (m.type === "jobs") { jobs = m.jobs; render(); }
  if (m.type === "host") showHost(m);
});

function showHost(h) {
  const w = $("hostWarn");
  if (h.ok) {
    hostSettings = h.settings;
    const missing = [!h.ytdlp && "yt-dlp", !h.ffmpeg && "ffmpeg"].filter(Boolean);
    w.hidden = !missing.length;
    if (missing.length) w.innerHTML = `Video sites need <b>${missing.join(" and ")}</b>. Install with <code>brew install yt-dlp ffmpeg</code>.`;
  } else {
    w.hidden = false;
    w.innerHTML = `Can't reach the VeloDM helper app (${h.error || "not installed"}).\n` +
      `Run <code>./install.sh</code> in the velodm folder, then reload this page.`;
  }
}

function act(cmd, id, extra = {}) { vdmSend({ cmd: "host", payload: { cmd, id, ...extra } }); }

function render() {
  const q = $("search").value.trim().toLowerCase();
  const rows = jobs.filter((j) =>
    (filter === "all" || j.status === filter) &&
    (!q || (j.filename + " " + j.url + " " + (j.title || "")).toLowerCase().includes(q)));
  $("empty").hidden = jobs.length > 0;
  const tb = $("rows");
  tb.replaceChildren(...rows.map(row));
}

function row(j) {
  const pct = j.size ? Math.min(100, (j.done / j.size) * 100) : j.status === "done" ? 100 : 0;
  const track = el("div", { class: "track" });
  if (j.parts && j.size && j.status === "downloading") {
    // draw each connection's segment, like IDM's segment map
    for (const [a, b, got] of j.parts) {
      track.append(el("div", { class: "seg", style: `left:${(a / j.size) * 100}%;width:${(got / j.size) * 100}%` }));
    }
  } else {
    track.append(el("div", { class: "fill", style: `width:${pct}%` }));
  }
  const label = {
    downloading: j.stage === "merging" ? "Merging audio + video…" : `${pct.toFixed(1)}%` + (j.connections ? ` · ${j.connections} connections` : ""),
    queued: "Queued", paused: `Paused at ${pct.toFixed(1)}%`, done: "Finished", error: "Failed",
  }[j.status] || j.status;

  const btn = (txt, title, fn) => el("button", { class: "icon", title, onclick: fn }, txt);
  const acts = el("td", { class: "acts" });
  if (j.status === "downloading" || j.status === "queued") acts.append(btn("⏸", "Pause", () => act("pause", j.id)));
  if (j.status === "paused" || j.status === "error") acts.append(btn("▶", "Resume", () => act("resume", j.id)));
  if (j.status === "done") {
    acts.append(btn("Open", "Open file", () => act("open", j.id)), " ", btn("Show", "Show in Finder", () => act("reveal", j.id)));
  }
  acts.append(" ", btn("↻", "Download again", () => act("redownload", j.id)));
  acts.append(" ", btn("✕", j.status === "done" ? "Remove from list" : "Cancel and delete partial file", () => {
    if (j.status === "done") {
      const del = confirm(`Delete "${j.filename}" from disk too?\nOK = delete the file. Cancel = keep the file, just remove it from the list.`);
      act("remove", j.id, { deleteFile: del });
    } else act("cancel", j.id);
  }));

  return el("tr", { class: "status-" + j.status },
    el("td", {},
      el("div", { class: "name", title: j.path || j.filename }, j.filename || j.title || j.url),
      el("div", { class: "sub" + (j.error ? " err" : ""), title: j.url }, j.error || j.page || j.url)),
    el("td", { class: "num" }, j.size ? (j.status === "done" ? fmtBytes(j.size) : `${fmtBytes(j.done)} / ${fmtBytes(j.size)}`) : fmtBytes(j.done)),
    el("td", { class: "prog" }, track, el("div", { class: "pct" }, label)),
    el("td", { class: "num" }, j.status === "downloading" ? fmtBytes(j.speed) + "/s" : ""),
    el("td", { class: "num" }, j.status === "downloading" ? fmtTime(j.eta) : ""),
    acts);
}

$("filters").addEventListener("click", (e) => {
  const f = e.target.dataset?.f;
  if (!f) return;
  filter = f;
  for (const b of $("filters").querySelectorAll("button")) b.classList.toggle("on", b.dataset.f === f);
  render();
});
$("search").addEventListener("input", render);
$("pauseAll").onclick = () => vdmSend({ cmd: "host", payload: { cmd: "pauseAll" } });
$("resumeAll").onclick = () => vdmSend({ cmd: "host", payload: { cmd: "resumeAll" } });
$("clearDone").onclick = () => vdmSend({ cmd: "host", payload: { cmd: "clearDone" } });
$("openFolder").onclick = () => vdmSend({ cmd: "host", payload: { cmd: "open" } });

$("add").onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (/^https?:\/\//.test(t)) $("addUrl").value = t;
  } catch {}
  $("addDlg").showModal();
};
$("addDlg").addEventListener("close", () => {
  if ($("addDlg").returnValue !== "ok") return;
  vdmSend({ cmd: "download", url: $("addUrl").value.trim(), filename: $("addName").value.trim() || undefined,
            engine: $("addEngine").value, page: $("addUrl").value.trim() });
  $("addForm").reset();
});

async function openSettings() {
  const s = await vdmSettings();
  const h = hostSettings || {};
  $("sDir").value = h.downloadDir || "";
  $("sConn").value = h.connections || 8;
  $("sMax").value = h.maxActive || 3;
  $("sLimit").value = Math.round((h.speedLimit || 0) / 1024);
  $("sCat").checked = h.categorize !== false;
  $("sCapture").checked = s.capture;
  $("sTypes").value = s.captureTypes;
  $("sMinSize").value = s.minSizeKB;
  $("sSkip").value = s.skipSites;
  $("sPanel").checked = s.panel;
  $("settingsDlg").showModal();
}
$("settingsBtn").onclick = openSettings;
$("settingsDlg").addEventListener("close", async () => {
  if ($("settingsDlg").returnValue !== "ok") return;
  await chrome.storage.local.set({
    capture: $("sCapture").checked, captureTypes: $("sTypes").value.trim(),
    minSizeKB: +$("sMinSize").value || 0, skipSites: $("sSkip").value.trim(), panel: $("sPanel").checked,
  });
  vdmSend({ cmd: "host", payload: { cmd: "settings", set: {
    downloadDir: $("sDir").value.trim(), connections: +$("sConn").value || 8, maxActive: +$("sMax").value || 3,
    speedLimit: (+$("sLimit").value || 0) * 1024, categorize: $("sCat").checked,
  } } });
});
if (location.hash === "#settings") setTimeout(openSettings, 300);
render();
