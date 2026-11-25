// Shared by background, popup and manager pages.
const VDM_DEFAULTS = {
  capture: true,
  captureTypes:
    "zip rar 7z gz tgz bz2 xz tar dmg iso pkg exe msi apk deb rpm " +
    "mp4 mkv webm mov avi flv m4v wmv 3gp mpg mpeg ts " +
    "mp3 m4a aac flac wav ogg opus wma " +
    "pdf epub doc docx xls xlsx ppt pptx torrent bin img",
  minSizeKB: 300,
  skipSites: "docs.google.com\nmail.google.com\ndrive.google.com",
  panel: true,
};

async function vdmSettings() {
  const s = await chrome.storage.local.get(VDM_DEFAULTS);
  return { ...VDM_DEFAULTS, ...s };
}

function fmtBytes(n) {
  if (!n || n < 0) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0) : n) + " " + u[i];
}

function fmtTime(s) {
  if (s == null || !isFinite(s)) return "–";
  s = Math.round(s);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

function vdmSend(msg) {
  return chrome.runtime.sendMessage({ to: "bg", ...msg });
}
