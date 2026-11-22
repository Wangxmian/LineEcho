#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

if [[ ! -x .venv/bin/python ]]; then
  echo "未找到项目虚拟环境。请先运行 scripts/install.command。"
  exit 1
fi

.venv/bin/python -m pip --isolated --disable-pip-version-check --no-cache-dir install -r requirements-translation.txt
.venv/bin/python -m pip check

model_dir=models/MarianMT-en-zh
revision=408d9bc410a388e1d9aef112a2daba955b945255
repo=Helsinki-NLP/opus-mt-en-zh
source_url=https://huggingface.co
mirror_url=https://hf-mirror.com
mkdir -p "$model_dir"

verified() {
  [[ -f "$2" ]] && printf '%s  %s\n' "$1" "$2" | /usr/bin/shasum -a 256 -sc
}

while read -r digest asset; do
  file="$model_dir/$asset"
  if verified "$digest" "$file"; then
    continue
  fi

  echo "下载 MarianMT 的 $asset"
  for endpoint in "$source_url" "$mirror_url"; do
    if /usr/bin/curl --fail --silent --show-error --location --retry 1 \
         --connect-timeout 10 --max-time 720 "$endpoint/$repo/resolve/$revision/$asset?download=true" -o "$file.part" &&
       verified "$digest" "$file.part"; then
      mv "$file.part" "$file"
      source_url="$endpoint"
      break
    fi
  done
  if ! verified "$digest" "$file"; then
    echo "MarianMT 文件下载或校验失败：$asset"
    exit 1
  fi
done < scripts/translation-model.sha256

echo "MarianMT 已安装。重新启动 Kokoro Reader 后可离线逐句翻译。"
