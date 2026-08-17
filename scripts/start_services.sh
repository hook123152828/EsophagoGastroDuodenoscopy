#!/usr/bin/env bash
# Start the three model microservices and the gateway.
# Each model runs in its own conda environment; override the names below if
# yours differ.  Logs land in logs/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GNS_ENV="${GNS_ENV:-GNS}"
GIM_ENV="${GIM_ENV:-IM_web}"
CGI_ENV="${CGI_ENV:-cgi_env}"
GATEWAY_ENV="${GATEWAY_ENV:-endo-gateway}"
CONDA_BASE="${CONDA_BASE:-$(conda info --base)}"

mkdir -p logs
export PYTHONPATH="$ROOT:${PYTHONPATH:-}"

# Always start from a clean slate. Without this, a second run would fail to bind
# the ports, die, and still overwrite logs/*.pid with the dead pids — leaving the
# processes from the first run unstoppable and holding the ports.
bash "$ROOT/scripts/stop_services.sh" >/dev/null 2>&1 || true

launch() {
  local env_name="$1" module="$2" name="$3"
  local python="$CONDA_BASE/envs/$env_name/bin/python"
  if [[ ! -x "$python" ]]; then
    echo "!! conda env '$env_name' not found (expected $python)" >&2
    echo "   see README.md for how to create it" >&2
    return 1
  fi
  "$python" -m "$module" >"logs/$name.log" 2>&1 &
  echo "$!" >"logs/$name.pid"
  echo "   $name  (pid $!, env $env_name)"
}

# Waits for one service, but gives up immediately if its process has died —
# so a missing weight file surfaces in seconds rather than after a long timeout.
wait_for() {
  local name="$1" url="$2"
  local pid
  pid="$(cat "logs/$name.pid")"

  for _ in $(seq 1 150); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "   $name ready"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "!! $name exited during startup — see logs/$name.log:" >&2
      tail -n 3 "logs/$name.log" | sed 's/^/     /' >&2
      return 1
    fi
    sleep 2
  done

  echo "!! $name did not come up within 5 minutes — see logs/$name.log" >&2
  return 1
}

echo "starting services..."
launch "$GNS_ENV"     backend.servers.gns_server gns
launch "$GIM_ENV"     backend.servers.gim_server gim
launch "$CGI_ENV"     backend.servers.cgi_server cgi
launch "$GATEWAY_ENV" backend.gateway            gateway

echo
echo "waiting for models to load (weights are multi-GB, this takes a while)..."

failed=0
wait_for gateway "http://127.0.0.1:8080/api/health" || failed=1
wait_for cgi     "http://127.0.0.1:8002/health"     || failed=1
wait_for gns     "http://127.0.0.1:8000/health"     || failed=1
wait_for gim     "http://127.0.0.1:8001/health"     || failed=1

echo
curl -s http://127.0.0.1:8080/api/health || echo "gateway not responding"
echo

if [[ "$failed" -ne 0 ]]; then
  echo
  echo "!! some services failed to start. Run scripts/stop_services.sh and check logs/." >&2
  exit 1
fi

echo
echo "gateway  http://127.0.0.1:8080"
echo "frontend cd frontend && npm run dev   ->  http://localhost:5173"
