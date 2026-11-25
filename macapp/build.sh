#!/bin/bash
# Builds VeloDM.app (universal SwiftUI app, ad-hoc signed) into ./build
set -euo pipefail
cd "$(dirname "$0")"
APP=build/VeloDM.app
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -parse-as-library -target $arch-apple-macos14.0 VeloDM.swift -o build/VeloDM-$arch
done
lipo -create build/VeloDM-arm64 build/VeloDM-x86_64 -output "$APP/Contents/MacOS/VeloDM"
rm build/VeloDM-arm64 build/VeloDM-x86_64
cp ../extension/icons/128.png build/icon.png
mkdir -p build/AppIcon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out build/AppIcon.iconset/icon_${s}x${s}.png >/dev/null
  sips -z $((s*2)) $((s*2)) build/icon.png --out build/AppIcon.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf build/AppIcon.iconset build/icon.png
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>VeloDM</string>
  <key>CFBundleDisplayName</key><string>VeloDM</string>
  <key>CFBundleIdentifier</key><string>local.velodm.app</string>
  <key>CFBundleExecutable</key><string>VeloDM</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
echo "built $APP"
