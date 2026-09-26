#!/usr/bin/env sh
# VerNess launcher (macOS/Linux). Windows: use turn_on.ps1 or turn_on.cmd.
# Everything is configured in verness.config.json — see docs/06-SETUP-AND-LAUNCHER.md.
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not on PATH. Install Node 22.19+ or 24+ from https://nodejs.org" >&2
  exit 1
fi
exec node "$DIR/scripts/verness.mjs" "$@"
