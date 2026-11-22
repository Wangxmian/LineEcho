#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "此构建需要 Apple Silicon。"
  exit 1
fi

root="$PWD"
build="${KOKORO_MACOS_BUILD_DIR:-$root/.runtime/macos-build}"
out="${KOKORO_MACOS_OUTPUT_DIR:-$root/outputs/macos}"
archives="${KOKORO_MACOS_RUNTIME_DIR:-$build/archives}"
name="$(/usr/bin/plutil -extract CFBundleName raw macos/Info.plist)"
version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw macos/Info.plist)"
app="$out/$name.app"
dmg="$out/$name-$version-arm64.dmg"
python_site="$root/.venv/lib/python3.13/site-packages"
mkdir -p "$build" "$out" "$archives"

download() {
  local file="$1" url="$2" hash="$3"
  if [[ ! -f "$file" ]]; then
    /usr/bin/curl -fsSL --retry 1 --connect-timeout 10 --max-time 480 "$url" -o "$file.part"
    printf '%s  %s\n' "$hash" "$file.part" | /usr/bin/shasum -a 256 -c
    mv "$file.part" "$file"
  fi
  printf '%s  %s\n' "$hash" "$file" | /usr/bin/shasum -a 256 -c
}

if [[ "${1:-}" != "--dmg-only" ]]; then
  if [[ ! -d "$python_site/mlx" || ! -f "$root/models/MTranServer/models/en_zh-Hans/model.onnx" ]]; then
    echo "请先准备项目的 Python 依赖、Kokoro 和 MTranServer 模型。"
    exit 1
  fi

  download "$archives/node.tar.xz" \
    'https://nodejs.org/dist/v25.8.2/node-v25.8.2-darwin-arm64.tar.xz' \
    'ed0d0d6a1a2594d557f36f451ff34dff321d37b7ecb0d24b87c9ff2051086a18'

  stage="$(mktemp -d "$build/app.XXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  bundle="$stage/$name.app"
  contents="$bundle/Contents"
  resources="$contents/Resources"
  mkdir -p "$contents/MacOS" "$resources/node" "$resources/macos" "$resources/scripts" \
    "$resources/models" "$resources/.runtime/mtranserver"
  cp macos/Info.plist "$contents/Info.plist"
  cp macos/serve.py "$resources/macos/serve.py"
  cp -R macos/licenses "$resources/licenses"
  cp macos/ThirdPartyNotices.md "$resources/ThirdPartyNotices.md"
  xcrun swift -module-cache-path "$build/swift-cache" macos/RenderIcon.swift "$stage/KokoroReader.iconset"
  /usr/bin/iconutil -c icns "$stage/KokoroReader.iconset" -o "$resources/KokoroReader.icns"
  cp scripts/mtran-worker.mjs "$resources/scripts/mtran-worker.mjs"
  xcrun swiftc -parse-as-library -target arm64-apple-macosx26.0 -O \
    -module-cache-path "$build/swift-cache" macos/ReaderApp.swift -o "$contents/MacOS/KokoroReader"

  if [[ -s "$archives/python.tar.gz" ]] && printf '%s  %s\n' \
      '29d38bd5fbe267b37cecac990015c662796edcf51c2f5e321d59ec06a1850816' "$archives/python.tar.gz" | /usr/bin/shasum -a 256 -sc; then
    /usr/bin/tar -xzf "$archives/python.tar.gz" -C "$resources"
  else
    .venv/bin/python -B macos/relocate-python.py "$resources/python"
  fi
  /usr/bin/tar -xJf "$archives/node.tar.xz" -C "$resources/node" --strip-components=1 \
    node-v25.8.2-darwin-arm64/bin/node node-v25.8.2-darwin-arm64/LICENSE
  rsync -a --exclude='__pycache__/' --exclude='*.pyc' \
    --exclude='torch/' --exclude='torch-*' --exclude='functorch/' --exclude='torchgen/' \
    --exclude='sympy*' --exclude='mpmath*' --exclude='networkx*' --exclude='opencc*' \
    "$python_site/" "$resources/python/lib/python3.13/site-packages/"
  rsync -a --exclude='__pycache__/' --exclude='*.pyc' app frontend "$resources/"
  rsync -a models/Kokoro-82M-bf16 models/MTranServer "$resources/models/"
  rsync -a .runtime/mtranserver/ "$resources/.runtime/mtranserver/"
  /usr/bin/codesign --force --deep --sign - --entitlements macos/Entitlements.plist "$bundle"
  /usr/bin/codesign --verify --deep --strict "$bundle"
  if [[ -e "$app" ]]; then
    backup="$(mktemp -d "$build/previous-app.XXXXXX")"
    mv "$app" "$backup/"
  fi
  mv "$bundle" "$app"
  echo "$app"
fi

if [[ "${1:-}" != "--app-only" ]]; then
  /usr/bin/codesign --verify --deep --strict "$app"
  image_stage="$(mktemp -d "$build/image.XXXXXX")"
  trap 'rm -rf -- "${stage:-}" "$image_stage"' EXIT
  /usr/bin/ditto "$app" "$image_stage/$name.app"
  ln -s /Applications "$image_stage/Applications"
  /usr/bin/hdiutil create -ov -volname "$name" -srcfolder "$image_stage" \
    -format UDZO -imagekey zlib-level=3 "$dmg"
  /usr/bin/hdiutil verify "$dmg"
  echo "$dmg"
fi
