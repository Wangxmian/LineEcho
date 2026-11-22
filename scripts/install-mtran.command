#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "MTranServer 需要 Apple Silicon 版 Node.js 18 或以上版本及 npm。"
  exit 1
fi
if ! node -e 'process.exit(process.platform === "darwin" && process.arch === "arm64" && Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  echo "请在 Apple Silicon Mac 上使用 ARM64 版 Node.js 18 或以上版本。"
  exit 1
fi

root="$PWD"
runtime="$root/.runtime/mtranserver"
module="$runtime/node_modules/mtranserver"
binding="$runtime/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node"
if [[ ! -f "$module/dist/index.js" || ! -f "$binding" ]] ||
   ! node -e 'process.exit(require(process.argv[1]).version === "5.1.1" ? 0 : 1)' "$module/package.json"; then
  mkdir -p "$runtime"
  scratch="$(mktemp -d "$root/.runtime/mtran-install.XXXXXX")"
  trap 'rm -rf -- "$scratch"' EXIT
  npm --prefix "$scratch" --cache "$scratch/npm-cache" install --save-exact --no-fund --no-audit mtranserver@5.1.1
  rsync -a --exclude='/onnxruntime-node/bin/napi-v6/linux/' \
    --exclude='/onnxruntime-node/bin/napi-v6/win32/' \
    --exclude='/onnxruntime-node/bin/napi-v6/darwin/x64/' \
    "$scratch/node_modules/" "$runtime/node_modules/"
fi
node "$root/scripts/mtran-worker.mjs" "$runtime" "$root/models/MTranServer" --prepare
