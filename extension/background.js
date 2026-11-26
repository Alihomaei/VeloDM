importScripts("common.js");

const HOST = "com.velodm.host";

// ------------------------------------------------------------ native host link
let nport = null;
let hostInfo = { ok: false, error: "connecting" };
let lastJobs = [];
let rid = 0;
const pending = new Map();
const uiPorts = new Set();

function connect() {
  if (nport) return nport;
  try {
    nport = chrome.runtime.connectNative(HOST);
  } catch (e) {
    hostInfo = { ok: false, error: String(e) };
    return null;
  }
  nport.onMessage.addListener(onHostMessage);
  nport.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "disconnected";
    nport = null;
    hostInfo = { ok: false, error: err };
    for (const [, p] of pending) p.resolve({ error: err });
    pending.clear();
    broadcast({ type: "host", ...hostInfo });
    // reconnect with backoff while anybody cares
    setTimeout(() => { if (uiPorts.size || lastJobs.some((j) => j.status === "downloading")) hello(); }, 3000);
  });
  return nport;
}

function host(payload, timeout = 120000) {
  const p = connect();
  if (!p) return Promise.resolve({ error: hostInfo.error });
  const id = ++rid;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    setTimeout(() => { if (pending.delete(id)) resolve({ error: "timeout" }); }, timeout);
    try { p.postMessage({ ...payload, rid: id }); } catch (e) { pending.delete(id); resolve({ error: String(e) }); }
  });
}

async function hello() {
  const r = await host({ cmd: "hello" }, 10000);
  hostInfo = r.error ? { ok: false, error: r.error } : { ok: true, ...r };
  if (r.jobs) setJobs(r.jobs);
  broadcast({ type: "host", ...hostInfo, jobs: undefined });
  return hostInfo;
}

function onHostMessage(m) {
  if (m.type === "reply") {
    const p = pending.get(m.rid);
    if (p) { pending.delete(m.rid); p.resolve(m); }
  } else if (m.type === "jobs") {
    setJobs(m.jobs);
  } else if (m.type === "finished" || m.type === "failed") {
    notify(m.type === "finished" ? "Download complete" : "Download failed",
      (m.job.filename || m.job.url) + (m.job.error ? "\n" + m.job.error : ""), m.job.id);
  }
}

function setJobs(jobs) {
  lastJobs = jobs;
  broadcast({ type: "jobs", jobs });
  const active = jobs.filter((j) => j.status === "downloading");
  if (active.length) {
    const size = active.reduce((a, j) => a + (j.size || 0), 0);
    const done = active.reduce((a, j) => a + (j.done || 0), 0);
    chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
    chrome.action.setBadgeText({ text: size ? Math.floor((done / size) * 100) + "%" : "↓" });
  } else {
    chrome.action.setBadgeText({ text: "" });
    refreshBadgeForActiveTab();
  }
}

function broadcast(m) { for (const p of uiPorts) { try { p.postMessage(m); } catch {} } }

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== "ui") return;
  uiPorts.add(p);
  p.onDisconnect.addListener(() => uiPorts.delete(p));
  hello().then(() => p.postMessage({ type: "jobs", jobs: lastJobs }));
});

function notify(title, message, id) {
  chrome.notifications.create("vdm-" + (id || Date.now()), {
    type: "basic", iconUrl: "icons/128.png", title, message: message.slice(0, 250),
  });
}
chrome.notifications.onClicked.addListener((nid) => {
  if (nid.startsWith("vdm-")) host({ cmd: "reveal", id: nid.slice(4) });
});

function openManager() {
  const url = chrome.runtime.getURL("manager.html");
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs[0]) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
    else chrome.tabs.create({ url });
  });
}

// ---------------------------------------------------------------- send a job
async function cookiesFor(url) {
  try {
    const u = new URL(url);
    // registrable-ish domain so youtube.com cookies apply to www./m. as well
    const parts = u.hostname.split(".");
    const domain = parts.length > 2 ? parts.slice(-2).join(".") : u.hostname;
    const all = await chrome.cookies.getAll({ domain });
    const exact = await chrome.cookies.getAll({ url });
    const seen = new Set();
    return [...exact, ...all].filter((c) => {
      const k = c.domain + c.path + c.name;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map(({ name, value, domain, path, secure, expirationDate }) => ({ name, value, domain, path, secure, expirationDate }));
  } catch { return []; }
}

async function startDownload(d) {
  if (!d.url || !/^https?:/i.test(d.url)) return { error: "only http(s) URLs can be handed to VeloDM" };
  // Video pages (YouTube & co.) and stream manifests go to the extractor engine.
  let engine = d.engine && d.engine !== "auto" ? d.engine : null;
  if (!engine) engine = isVideoPage(d.url) || /\.(m3u8|mpd)(\?|$)/i.test(d.url) ? "ytdlp" : "direct";
  const job = {
    cmd: "download", url: d.url, engine, filename: d.filename, title: d.title,
    page: d.page || "", referer: d.referer || d.page || "",
    userAgent: navigator.userAgent, headers: d.headers || {},
    format: d.format, audioOnly: d.audioOnly,
    cookies: await cookiesFor(d.url),
  };
  const r = await host(job, 15000);
  if (r.error) notify("VeloDM helper not available", r.error + "\nRun install.sh, then restart Chrome.");
  return r;
}

const VIDEO_SITES = /^https?:\/\/([^/]+\.)?(youtube\.com\/(watch|shorts|live|embed)|youtu\.be\/|vimeo\.com\/\d|dailymotion\.com\/video|twitter\.com\/.+\/status|x\.com\/.+\/status|instagram\.com\/(p|reel|tv)\/|tiktok\.com\/.+\/video|facebook\.com\/.+\/videos|fb\.watch|twitch\.tv\/|reddit\.com\/r\/.+\/comments|soundcloud\.com\/|bilibili\.com\/video|streamable\.com\/|rumble\.com\/|ted\.com\/talks)/i;
function isVideoPage(url) { return VIDEO_SITES.test(url || ""); }

// ------------------------------------------------- media sniffing (per tab)
// Like IDM's "Download this video" detector: watch responses for media
// content types and stream manifests, remember them per tab.
const tabMedia = new Map(); // tabId -> Map(url -> item)

const MEDIA_CT = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|vnd\.ms-sstr\+xml|octet-stream))/i;

function classify(url, ct) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.m3u8$/.test(path) || /mpegurl/i.test(ct)) return "hls";
  if (/\.mpd$/.test(path) || /dash\+xml/i.test(ct)) return "dash";
  if (/\.(ts|m4s|aac|vtt|webvtt|key|init)$/.test(path) || /\/(seg|segment|chunk|frag)[-_]?\d+/i.test(path)) return null; // fragments
  if (/^(video|audio)\//i.test(ct) || /\.(mp4|webm|mkv|mov|flv|m4v|mp3|m4a|ogg|opus|wav|flac)$/.test(path)) return "file";
  return null;
}

// Embedded players (Wistia, Vimeo…) on pages yt-dlp can't read itself,
// e.g. course platforms. Their player URL is what yt-dlp understands.
function embedFromUrl(url) {
  let m = url.match(/^https?:\/\/(?:fast|embed(?:-ssl)?)\.wistia\.(?:com|net)\/embed\/(?:medias|iframe)\/([a-z0-9]{10})\b/i);
  if (m) return `https://fast.wistia.net/embed/iframe/${m[1]}`;
  m = url.match(/^https?:\/\/player\.vimeo\.com\/video\/(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  return null;
}

function remember(tabId, key, item) {
  if (!tabMedia.has(tabId)) tabMedia.set(tabId, new Map());
  const m = tabMedia.get(tabId);
  if (m.has(key)) return;
  m.set(key, { ...item, t: Date.now() });
  refreshBadge(tabId);
  chrome.tabs.sendMessage(tabId, { type: "mediaFound", count: m.size }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const embed = embedFromUrl(d.url);
  if (embed) return remember(d.tabId, embed, { url: embed, kind: "embed", size: 0, filename: "" });
  if (/^https?:\/\/[^/]*googlevideo\.com\/videoplayback/.test(d.url)) return; // YouTube chunks: use the page URL instead
  const h = Object.fromEntries((d.responseHeaders || []).map((x) => [x.name.toLowerCase(), x.value || ""]));
  const ct = h["content-type"] || "";
  if (!MEDIA_CT.test(ct) && !/\.(m3u8|mpd|mp4|webm|mp3|m4a)(\?|$)/i.test(d.url)) return;
  const kind = classify(d.url, ct);
  if (!kind) return;
  let size = 0;
  const cr = h["content-range"];
  if (cr && /\/\d+$/.test(cr)) size = +cr.split("/").pop();
  else if (h["content-length"]) size = +h["content-length"];
  if (kind === "file" && size && size < 512 * 1024) return; // ads, beeps, previews
  const key = kind === "file" ? d.url.replace(/([?&])(range|rn|rbuf|bytestart|byteend)=[^&]*/gi, "$1") : d.url;
  const name = decodeURIComponent(d.url.split(/[?#]/)[0].split("/").pop() || "");
  remember(d.tabId, key, { url: d.url, kind, size, ct, filename: /\.\w{2,4}$/.test(name) ? name : "" });
}, { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object", "sub_frame", "script"] }, ["responseHeaders"]);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) { tabMedia.delete(d.tabId); refreshBadge(d.tabId); }
});
chrome.tabs.onRemoved.addListener((id) => tabMedia.delete(id));
chrome.tabs.onActivated.addListener(refreshBadgeForActiveTab);

function refreshBadge(tabId) {
  if (lastJobs.some((j) => j.status === "downloading")) return;
  const n = tabMedia.get(tabId)?.size || 0;
  chrome.action.setBadgeBackgroundColor({ color: "#1a7f37", tabId });
  chrome.action.setBadgeText({ text: n ? String(n) : "", tabId });
}
function refreshBadgeForActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (t) => t[0] && refreshBadge(t[0].id));
}

// ------------------------------------------- take over browser downloads
// Chrome starts the download; we decide whether VeloDM should handle it,
// cancel Chrome's copy, and hand URL + cookies + referrer to the engine.
let bypassUntil = 0;   // Alt-click: let Chrome handle it
let forceUntil = 0;    // Shift+Alt-click: always VeloDM
const handedOver = new Set();

chrome.downloads.onCreated.addListener(async (item) => {
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url) || item.state !== "in_progress") return;   // blob:, data:, file:
  if (handedOver.has(url) || item.byExtensionId) return;   // fallback copies we started ourselves
  const now = Date.now();
  const forced = now < forceUntil;
  if (!forced && now < bypassUntil) return;
  // Takeover is opt-in (Settings). When it's off, leave Chrome's downloads
  // completely alone unless the user Shift+Alt-clicked to force VeloDM.
  const s = await vdmSettings();
  if (!forced && (!s.capture || !decideCapture(item, url, s))) return;
  // Hold Chrome's copy while we hand it over (the worker may have just been
  // woken by this event, with no helper connection yet).
  chrome.downloads.pause(item.id).catch(() => {});
  const giveBack = () => chrome.downloads.resume(item.id).catch(() => {});
  if (!hostInfo.ok) await hello();
  if (!hostInfo.ok) return giveBack();
  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {}
  handedOver.add(url);
  setTimeout(() => handedOver.delete(url), 10000);
  const r = await startDownload({
    url, page: item.referrer, referer: item.referrer, engine: "direct",
    filename: item.filename ? item.filename.split("/").pop() : undefined,
  });
  if (r.error) chrome.downloads.download({ url });   // never lose a download
});

function decideCapture(item, url, s) {
  const host_ = new URL(item.referrer || url).hostname;
  if (s.skipSites.split(/\s+/).filter(Boolean).some((d) => host_ === d || host_.endsWith("." + d))) return false;
  const name = (item.filename || url.split(/[?#]/)[0]).toLowerCase();
  const ext = (name.match(/\.([a-z0-9]{1,5})$/) || [])[1] || "";
  const types = new Set(s.captureTypes.toLowerCase().split(/[\s,]+/));
  const mimeHit = /^(video|audio)\//.test(item.mime || "") || /zip|rar|7z|octet-stream|x-apple-diskimage|pdf/.test(item.mime || "");
  if (!types.has(ext) && !(ext === "" && mimeHit)) return false;
  if (item.totalBytes > 0 && item.totalBytes < s.minSizeKB * 1024) return false;
  return true;
}

// ---------------------------------------------------------- context menus
chrome.runtime.onInstalled.addListener((d) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "link", title: "Download with VeloDM", contexts: ["link"] });
    chrome.contextMenus.create({ id: "media", title: "Download this video with VeloDM", contexts: ["video", "audio"] });
    chrome.contextMenus.create({ id: "page", title: "Download video from this page", contexts: ["page", "frame"] });
    chrome.contextMenus.create({ id: "links", title: "Download all links with VeloDM…", contexts: ["page", "selection"] });
  });
  if (d.reason === "install") openManager();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const page = info.frameUrl || info.pageUrl || tab?.url;
  if (info.menuItemId === "link") startDownload({ url: info.linkUrl, page });
  else if (info.menuItemId === "media") {
    const src = info.srcUrl || "";
    // blob:/MSE players: the real file is the page (YouTube) or a sniffed stream
    if (/^https?:/.test(src) && !isVideoPage(page)) startDownload({ url: src, page });
    else startDownload({ url: page, page, engine: "ytdlp" });
  } else if (info.menuItemId === "page") {
    startDownload({ url: tab.url, page: tab.url, engine: "ytdlp" });
  } else if (info.menuItemId === "links") {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: collectLinks, args: [(await vdmSettings()).captureTypes],
    });
    const links = result || [];
    if (!links.length) return notify("No downloadable links", "No links to files of your chosen types on this page.");
    if (!(await confirmInTab(tab.id, `Download ${links.length} files with VeloDM?\n\n` + links.slice(0, 15).join("\n") + (links.length > 15 ? "\n…" : "")))) return;
    for (const url of links) await startDownload({ url, page: tab.url });
    openManager();
  }
});

// runs in the page
function collectLinks(types) {
  const want = new Set(types.toLowerCase().split(/[\s,]+/));
  const sel = getSelection();
  const scope = sel && !sel.isCollapsed ? [...document.links].filter((a) => sel.containsNode(a, true)) : [...document.links];
  return [...new Set(scope.map((a) => a.href).filter((h) => {
    const m = h.split(/[?#]/)[0].toLowerCase().match(/\.([a-z0-9]{1,5})$/);
    return /^https?:/.test(h) && m && want.has(m[1]);
  }))];
}
async function confirmInTab(tabId, text) {
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: (t) => confirm(t), args: [text] });
  return !!result;
}

// --------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  const tabId = m.tabId ?? sender.tab?.id;
  (async () => {
    switch (m.cmd) {
      case "status": return { host: hostInfo.ok ? hostInfo : await hello(), jobs: lastJobs };
      case "host": return host(m.payload);
      case "download": return startDownload({ ...m, page: m.page || sender.tab?.url });
      case "probe": return host({ cmd: "probe", url: m.url, referer: m.referer || "", cookies: await cookiesFor(m.url), userAgent: navigator.userAgent }, 120000);
      case "tabMedia": return [...(tabMedia.get(tabId)?.values() || [])].sort((a, b) => b.t - a.t);
      case "isVideoPage": return isVideoPage(m.url);
      case "openManager": openManager(); return true;
      case "modifier":
        if (m.mode === "bypass") bypassUntil = Date.now() + 3000;
        if (m.mode === "force") forceUntil = Date.now() + 3000;
        return true;
    }
  })().then(reply);
  return true;
});

hello();
