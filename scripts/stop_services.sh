#!/usr/bin/env bash
# Stop everything started by start_services.sh.
#
# Kills by pid file first, then sweeps whatever is still listening on the
# service ports. The port sweep matters because a pid file can end up pointing
# at a process that died without ever binding — which would otherwise leave the
# real process running and holding the port forever.
#
# Deliberately not `pkill -f backend.gateway`: -f matches whole command lines,
# so it also kills shells that merely mention the module name.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORTS="${PORTS:-8000 8001 8002 8003 8080}"
stopped=0

for pidfile in logs/*.pid; do
  [[ -e "$pidfile" ]] || continue
  name="$(basename "$pidfile" .pid)"
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill "$pid" 2>/dev/null; then
    echo "stopped $name (pid $pid)"
    stopped=1
  fi
  rm -f "$pidfile"
done

listeners() {
  ss -ltnp 2>/dev/null | grep -oP ":$1\s.*pid=\K[0-9]+" | sort -u
}

sleep 1
for port in $PORTS; do
  for pid in $(listeners "$port"); do
    kill "$pid" 2>/dev/null && echo "stopped orphan on :$port (pid $pid)" && stopped=1
  done
done

sleep 1
for port in $PORTS; do
  for pid in $(listeners "$port"); do
    kill -9 "$pid" 2>/dev/null && echo "force-killed :$port (pid $pid)"
  done
done

[[ "$stopped" -eq 0 ]] && echo "nothing was running"
exit 0
