#!/usr/bin/env bash
# Stop everything started by start_services.sh.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for pidfile in logs/*.pid; do
  [[ -e "$pidfile" ]] || continue
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile")"
  if kill "$pid" 2>/dev/null; then
    echo "stopped $name (pid $pid)"
  fi
  rm -f "$pidfile"
done
