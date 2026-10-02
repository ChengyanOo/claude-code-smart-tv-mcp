#!/usr/bin/env bash
# Refresh YouTube cookie from browser (best-effort), then run the MCP server.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
if [ "${YT_COOKIE_AUTO:-1}" != "0" ]; then
  # stderr only; stdout is the MCP transport and must stay clean.
  /usr/bin/python3 "$HERE/yt-cookie.py" >&2 || true
fi
exec node "$ROOT/dist/index.js" "$@"
