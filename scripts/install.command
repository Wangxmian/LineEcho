#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

if [[ "$(uname -m)" != arm64 ]]; then
  echo "此安装脚本面向 Apple Silicon 的 MLX 版本。Intel Mac 需要 Kokoro 的 ONNX CPU 版本。"
  exit 1
fi
if [[ ! -x .venv/bin/python ]]; then
  for candidate in python3.13 python3.12 python3; do
    if command -v "$candidate" >/dev/null && "$candidate" -c 'import platform, sys; assert platform.machine() == "arm64" and sys.version_info[:2] in {(3, 12), (3, 13)}' 2>/dev/null; then
      "$candidate" -m venv .venv
      break
    fi
  done
fi
if [[ ! -x .venv/bin/python ]]; then
  echo "未找到 ARM64 Python 3.12 或 3.13。"
  exit 1
fi

.venv/bin/python -m pip --isolated --disable-pip-version-check --no-cache-dir install -r requirements.txt
.venv/bin/python -m pip check

model_dir=models/Kokoro-82M-bf16
revision=a71e4d38b236d968966a2002c4c895dbd12b1c3c
repo=mlx-community/Kokoro-82M-bf16
source_url=https://huggingface.co
mirror_url=https://hf-mirror.com
mkdir -p "$model_dir/voices" outputs

while read -r digest asset; do
  file="$model_dir/$asset"
  if [[ -f "$file" ]] && printf '%s  %s\n' "$digest" "$file" | /usr/bin/shasum -a 256 -sc; then
    continue
  fi

  echo "下载 $asset"
  for endpoint in "$source_url" "$mirror_url"; do
    if /usr/bin/curl --fail --silent --show-error --location --retry 1 \
         --connect-timeout 8 --max-time 360 "$endpoint/$repo/resolve/$revision/$asset" -o "$file.part" &&
       printf '%s  %s\n' "$digest" "$file.part" | /usr/bin/shasum -a 256 -sc; then
      mv "$file.part" "$file"
      [[ "$endpoint" == "$mirror_url" ]] && source_url="$mirror_url"
      break
    fi
  done
  if [[ ! -f "$file" ]] || ! printf '%s  %s\n' "$digest" "$file" | /usr/bin/shasum -a 256 -sc; then
    echo "下载或校验失败：$asset"
    exit 1
  fi
done < scripts/model.sha256
echo "安装完成。双击 start.command 即可打开网页。"
