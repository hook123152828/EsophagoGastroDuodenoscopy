#!/usr/bin/env bash
# Start the four model microservices and the gateway.
# Each model runs in its own conda environment; override the names below if
# yours differ.  Logs land in logs/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GNS_ENV="${GNS_ENV:-GNS}"
GIM_ENV="${GIM_ENV:-IM_web}"
CGI_ENV="${CGI_ENV:-cgi_env}"
POLYP_ENV="${POLYP_ENV:-polyp_env}"
GATEWAY_ENV="${GATEWAY_ENV:-endo-gateway}"
if [[ -z "${CONDA_BASE:-}" ]]; then
  if command -v conda >/dev/null 2>&1; then
    CONDA_BASE="$(conda info --base)"
  elif [[ -d "$HOME/miniconda3/envs" ]]; then
    CONDA_BASE="$HOME/miniconda3"
  elif [[ -d "$HOME/anaconda3/envs" ]]; then
    CONDA_BASE="$HOME/anaconda3"
  else
    echo "!! conda not found. Set CONDA_BASE to your conda install." >&2
    exit 1
  fi
fi

mkdir -p logs
export PYTHONPATH="$ROOT:${PYTHONPATH:-}"

GATEWAY_PY="$CONDA_BASE/envs/$GATEWAY_ENV/bin/python"

# Health probing goes through the gateway environment's own python rather than
# curl: curl is not installed system-wide on every machine, and when it is
# missing every probe fails silently and the script waits out its full timeout
# looking like a hang.
probe() {
  "$GATEWAY_PY" - "$1" <<'PY' 2>/dev/null
import sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], timeout=3) as response:
        sys.stdout.write(response.read().decode())
        sys.exit(0 if response.status < 400 else 1)
except Exception:
    sys.exit(1)
PY
}

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
    if probe "$url" >/dev/null; then
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
launch "$POLYP_ENV"   backend.servers.polyp_server polyp
launch "$GATEWAY_ENV" backend.gateway            gateway

echo
echo "waiting for models to load (weights are multi-GB, this takes a while)..."

failed=0
wait_for gateway "http://127.0.0.1:8080/api/health" || failed=1
wait_for cgi     "http://127.0.0.1:8002/health"     || failed=1
wait_for gns     "http://127.0.0.1:8000/health"     || failed=1
wait_for gim     "http://127.0.0.1:8001/health"     || failed=1
wait_for polyp   "http://127.0.0.1:8003/health"     || failed=1

echo
probe http://127.0.0.1:8080/api/health || echo "gateway not responding"
echo

if [[ "$failed" -ne 0 ]]; then
  echo
  echo "!! some services failed to start. Run scripts/stop_services.sh and check logs/." >&2
  exit 1
fi

echo
echo "gateway  http://127.0.0.1:8080"
echo "frontend cd frontend && npm run dev   ->  http://localhost:5173"
