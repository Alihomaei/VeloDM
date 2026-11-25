const $ = (id) => document.getElementById(id);
$("openMgr").onclick = () => { vdmSend({ cmd: "openManager" }); window.close(); };

// Turn yt-dlp's format list into IDM-style choices: one button per resolution + audio.
function qualityChoices(info) {
  const fm = info.formats || [];
  const bestAudio = fm.filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none")
    .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
  const byH = new Map();
  for (const f of fm) {
    if (!f.height || !f.vcodec || f.vcodec === "none") continue;
    const cur = byH.get(f.height);
    const score = (f.ext === "mp4" ? 1e6 : 0) + (f.tbr || 0);
    if (!cur || score > cur.score) byH.set(f.height, { ...f, score });
  }
  const list = [...byH.values()].sort((a, b) => b.height - a.height).map((f) => {
    const muxed = f.acodec && f.acodec !== "none";
    const size = (f.size || 0) + (muxed ? 0 : bestAudio?.size || 0);
    return {
      label: `${f.height}p${f.fps > 30 ? f.fps : ""}`,
      sub: size ? fmtBytes(size) : f.ext,
      format: `bv*[height=${f.height}]+ba/b[height=${f.height}]/b`,
    };
  });
  if (!list.length && fm.length) list.push({ label: "Best", sub: "", format: "bv*+ba/b" });
  if (bestAudio) list.push({ label: "Audio MP3", sub: bestAudio.size ? fmtBytes(bestAudio.size) : "", format: "ba/b", audioOnly: true });
  return list;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const st = await vdmSend({ cmd: "status" });
  if (!st?.host?.ok) {
    $("hostWarn").hidden = false;
    $("hostWarn").innerHTML = "VeloDM helper app isn't connected. Run <code>./install.sh</code> in the velodm folder, then restart Chrome.";
  }
  renderRecent(st?.jobs || []);

  // Streams sniffed from network traffic in this tab (HLS, DASH, MP4…)
  const media = (await vdmSend({ cmd: "tabMedia", tabId: tab.id })) || [];
  if (media.length) {
    $("streamsSec").hidden = false;
    $("streams").replaceChildren(...media.slice(0, 12).map((m) =>
      el("div", { class: "mini" },
        el("div", { class: "grow" },
          el("div", { class: "name", title: m.url }, m.filename || m.url),
          el("div", { class: "sub" }, [m.kind.toUpperCase(), m.size ? fmtBytes(m.size) : ""].filter(Boolean).join(" · "))),
        el("button", { onclick: () => grab({ url: m.url, engine: m.kind === "file" ? "direct" : "ytdlp", filename: m.filename, page: tab.url }) }, "Download"))));
  }

  if (!/^https?:/.test(tab.url || "")) { $("page").innerHTML = '<p class="muted">Open a web page to grab its video.</p>'; return; }
  const info = await vdmSend({ cmd: "probe", url: tab.url });
  if (!info || info.error) {
    $("page").replaceChildren(el("p", { class: "muted" }, media.length ? "Use a detected stream below." : "No downloadable video found on this page."));
    return;
  }
  const choices = qualityChoices(info);
  $("page").replaceChildren(el("div", { class: "card" },
    info.thumbnail ? el("img", { class: "thumb", src: info.thumbnail, alt: "" }) : null,
    el("div", { class: "t", title: info.title }, info.title || tab.title),
    el("div", { class: "sub" }, [info.extractor, info.uploader, info.duration ? fmtTime(info.duration) : ""].filter(Boolean).join(" · ")),
    el("div", { class: "fmts", style: "margin-top:8px" }, choices.map((c) =>
      el("button", { onclick: () => grab({ url: tab.url, engine: "ytdlp", format: c.format, audioOnly: !!c.audioOnly, title: info.title, page: tab.url }) },
        c.label, c.sub ? el("small", {}, c.sub) : null)))));
}

async function grab(d) {
  await vdmSend({ cmd: "download", ...d });
  vdmSend({ cmd: "openManager" });
  window.close();
}

function renderRecent(jobs) {
  if (!jobs.length) return;
  $("recent").replaceChildren(...jobs.slice(0, 5).map((j) => {
    const pct = j.size ? Math.round((j.done / j.size) * 100) : 0;
    return el("div", { class: "mini" },
      el("div", { class: "grow" },
        el("div", { class: "name" }, j.filename || j.title || j.url),
        el("div", { class: "sub" }, j.status === "downloading" ? `${pct}% · ${fmtBytes(j.speed)}/s` : j.status)));
  }));
}

main();
