# VeloDM

A download manager for macOS that works like Internet Download Manager (IDM) on Windows.
It is a Chrome extension plus a native Mac app, built from scratch. No IDM code is used.

- **Faster downloads:** each file is split into up to 32 byte ranges fetched in parallel.
  Whenever a connection frees up, the largest remaining range is split again.
- **Pause and resume**, even across a Chrome restart or a reboot.
- **Video grabber:** a "Download video" button appears on players (YouTube, Vimeo, X,
  Instagram, TikTok, Reddit, Twitch and about 1,800 more sites through
  [yt-dlp](https://github.com/yt-dlp/yt-dlp)). You pick a resolution or MP3 from the
  button's menu. It also handles HLS (`.m3u8`) and DASH (`.mpd`) streams.
- **Only downloads what you send it:** the video button, right-click → "Download with
  VeloDM", the popup, or the Mac app. Chrome's normal downloads are left alone. You can
  optionally turn on takeover of chosen file types (zip, dmg, mp4, pdf…) in Settings.
  Shift+Alt-click a link to send it to VeloDM once; Alt-click lets Chrome keep it.
- **Mac app:**
  - Downloads table with a per-connection progress map, speed and time left.
  - Filters by status and category; sorts files into Video, Music, Compressed,
    Documents and Programs folders.
  - Add a URL (⌘N) with a quality picker, or drop a link on the window.
  - Menu bar speed indicator and a Dock badge.
- **Downloads keep running with Chrome closed.** A background engine owns them, not the
  browser.

## How it works

The design is the same as IDM's: the browser extension only spots downloads and videos,
and a separate engine does the actual downloading.

```
Chrome extension ──native messaging──▶ velodm_relay.py ─┐
                                                        ├─▶ velodm_engine.py  (daemon, Unix socket)
VeloDM.app (SwiftUI, menu bar) ─────────────────────────┘    ├─ multi-connection HTTP downloader
                                                             └─ yt-dlp + ffmpeg (video sites, HLS/DASH)
```

| Path | What |
|---|---|
| `extension/` | Chrome MV3 extension: download takeover, video button, media sniffing, popup, manager page |
| `host/velodm_engine.py` | Download engine daemon. State lives in `~/Library/Application Support/VeloDM` |
| `host/velodm_relay.py` | Chrome native-messaging relay to the engine (starts the engine if needed) |
| `macapp/` | SwiftUI app (`build.sh` builds an ad-hoc signed universal `VeloDM.app`) |
| `install.sh` | Sets everything up (see below) |

YouTube changes its player often. VeloDM keeps its own copy of yt-dlp, with the official
challenge solver (`yt-dlp[default]`), in `~/Library/Application Support/VeloDM/venv`,
and the engine updates it daily. If a request that carries your signed-in cookies fails,
the engine retries without them.

## Install

Requirements: macOS 14+, Python 3, and Xcode command-line tools (`xcode-select --install`).

```bash
brew install ffmpeg deno        # ffmpeg merges video and audio; deno solves YouTube's challenges
./install.sh                    # add --login-item to start the engine at login
```

`install.sh` does the following:
- installs the engine, the relay and a private, current yt-dlp into
  `~/Library/Application Support/VeloDM`
- registers the native-messaging host for Chrome, Brave, Edge, Arc and Chromium
- builds `VeloDM.app` into `~/Applications`

Then load the extension:
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. Restart Chrome once.

The extension ID is fixed by the `key` in `manifest.json` (`ngkpmomdlibghcpgidealkkkdgehdmoc`),
so it matches the native-host registration.

To uninstall:
```bash
launchctl bootout gui/$(id -u)/local.velodm.engine 2>/dev/null
rm -rf ~/Applications/VeloDM.app "$HOME/Library/Application Support/VeloDM" ~/Library/LaunchAgents/local.velodm.engine.plist
rm -f ~/Library/Application\ Support/*/NativeMessagingHosts/com.velodm.host.json ~/Library/Application\ Support/*/*/NativeMessagingHosts/com.velodm.host.json
```

## Limits

- The Chrome Web Store doesn't allow YouTube downloaders, so the extension is loaded
  unpacked.
- DRM-protected streams (Netflix, Disney+, Spotify, …) can't be downloaded.
- Only download content you have the right to download, and respect each site's terms.

## License

Apache 2.0. VeloDM is not affiliated with Tonec FZE or Internet Download Manager.
