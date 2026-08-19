#!/usr/bin/env bash
# Dev-mode ArchFlow MCP launcher for developing ArchFlow itself inside this repository.
#
# With ARCHFLOW_DEV=1, serve this checkout's own tracked dist bundle instead of the
# machine-global install, so a dev session exercises the branch's bytes without
# installing (installs are machine-global and affect everyone). ARCHFLOW_DEV_DIST
# optionally overrides the bundle directory. Any other value falls through to the
# installed launcher, which remains the normal path for repositories that use —
# rather than develop — ArchFlow.
set -euo pipefail

if [ "${ARCHFLOW_DEV:-0}" = "1" ]; then
  dist="${ARCHFLOW_DEV_DIST:-$(cd "$(dirname "$0")/.." && pwd)/dist}"
  if [ ! -f "$dist/archflow-mcp.mjs" ]; then
    echo "ARCHFLOW_DEV=1 but $dist/archflow-mcp.mjs is missing; run the release loop (npm run release:write) or unset ARCHFLOW_DEV" >&2
    exit 1
  fi
  exec node "$dist/archflow-mcp.mjs" "$@"
fi

exec archflow-mcp "$@"
