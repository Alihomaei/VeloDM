#!/bin/bash
# Installs VeloDM on macOS:
#   - download engine daemon + Chrome relay in ~/Library/Application Support/VeloDM
#   - Chrome / Brave / Edge / Arc / Chromium native-messaging registration
#   - VeloDM.app in ~/Applications
#   - with --login-item: a LaunchAgent that starts the engine at login,
#     so unfinished downloads resume after a reboot without opening anything
set -euo pipefail
cd "$(dirname "$0")"
EXT_ID="ngkpmomdlibghcpgidealkkkdgehdmoc"
APP="$HOME/Library/Application Support/VeloDM"
PY="$(command -v python3 || true)"
[ -x "$PY" ] || { echo "python3 is required (brew install python)"; exit 1; }
command -v ffmpeg >/dev/null || echo "warning: ffmpeg not found - needed to merge video+audio: brew install ffmpeg"

mkdir -p "$APP"
# Private, current yt-dlp + its YouTube challenge solver (yt-dlp-ejs). The engine
# refreshes it daily; Homebrew's copy often lags YouTube's player changes.
[ -x "$APP/venv/bin/pip" ] || "$PY" -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --disable-pip-version-check --upgrade "yt-dlp[default]"
touch "$APP/ytdlp-updated"
echo "yt-dlp $("$APP/venv/bin/yt-dlp" --version) ready"
command -v deno >/dev/null || command -v node >/dev/null || echo "warning: no JavaScript runtime (brew install deno) - some YouTube formats may be missing"
# stop a running engine so the new code takes over (jobs resume on restart)
if [ -S "$APP/engine.sock" ]; then
  "$PY" -I - "$APP/engine.sock" <<'PYQ' 2>/dev/null || true
import socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(sys.argv[1])
s.sendall(b'{"cmd":"quit","rid":1}\n')
buf = b""
while b'"rid":1' not in buf:
    d = s.recv(65536)
    if not d: break
    buf += d
PYQ
  sleep 2
  pkill -f "$APP/velodm_engine.py" 2>/dev/null && sleep 1 || true   # still running: stop it the hard way
fi
rm -f "$APP/velodm_host.py" "$APP/velodm-host"
cp host/velodm_engine.py host/velodm_relay.py "$APP/"

cat > "$APP/velodm-engine" <<SH
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$PY" -I "$APP/velodm_engine.py" "\$@"
SH
cat > "$APP/velodm-relay" <<SH
#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$PY" -I "$APP/velodm_relay.py" "\$@"
SH
chmod +x "$APP/velodm-engine" "$APP/velodm-relay"

for B in "Google/Chrome" "Google/Chrome Beta" "Google/Chrome Canary" "Chromium" "BraveSoftware/Brave-Browser" "Microsoft Edge" "Arc/User Data"; do
  D="$HOME/Library/Application Support/$B"
  [ -d "$D" ] || continue
  mkdir -p "$D/NativeMessagingHosts"
  cat > "$D/NativeMessagingHosts/com.velodm.host.json" <<JSON
{
  "name": "com.velodm.host",
  "description": "VeloDM download engine relay",
  "path": "$APP/velodm-relay",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
  echo "registered with $B"
done

if [ "${1:-}" = "--login-item" ]; then
  # Login item: start the engine at login (it resumes queued downloads)
  LA="$HOME/Library/LaunchAgents/local.velodm.engine.plist"
  mkdir -p "$(dirname "$LA")"
  cat > "$LA" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.velodm.engine</string>
  <key>ProgramArguments</key><array><string>$APP/velodm-engine</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/local.velodm.engine" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA" 2>/dev/null || true
  echo "login item installed (remove: launchctl bootout gui/$(id -u)/local.velodm.engine; rm \"$LA\")"
fi

# Mac app
if command -v swiftc >/dev/null; then
  ./macapp/build.sh >/dev/null
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/VeloDM.app"
  cp -R macapp/build/VeloDM.app "$HOME/Applications/"
  echo "installed ~/Applications/VeloDM.app"
else
  echo "swiftc not found (xcode-select --install) - skipped the Mac app"
fi

# start the (new) engine now; it is single-instance, so this is a no-op if the app beat us to it
nohup "$APP/velodm-engine" >/dev/null 2>&1 &
# relaunch the app if it was open, so it runs the freshly built binary
if pgrep -f "Applications/VeloDM.app/Contents/MacOS/VeloDM" >/dev/null; then
  pkill -f "Applications/VeloDM.app/Contents/MacOS/VeloDM"; sleep 1; open "$HOME/Applications/VeloDM.app"
fi

echo
echo "Chrome: chrome://extensions -> Developer mode -> Load unpacked -> $(pwd)/extension"
echo "Then restart Chrome once so it picks up the helper registration."
