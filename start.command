#!/bin/bash
set -eu
cd -- "$(dirname -- "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo "缺少项目虚拟环境。请先运行 scripts/install.command。"
  exit 1
fi
exec .venv/bin/python scripts/control.py start "$@"
