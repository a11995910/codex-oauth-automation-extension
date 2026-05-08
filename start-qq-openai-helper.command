#!/bin/zsh
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  exec python3 scripts/qq_openai_code_helper.py --open
fi

exec python scripts/qq_openai_code_helper.py --open
