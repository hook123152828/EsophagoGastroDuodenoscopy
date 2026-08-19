#!/usr/bin/env bash
# Start the three required model microservices, optional GutCore, and gateway.
# Each model runs in its own conda environment; override the names below if
# yours differ.  Logs land in logs/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GNS_ENV="${GNS_ENV:-GNS}"
GIM_ENV="${GIM_ENV:-IM_web}"
CGI_ENV="${CGI_ENV:-cgi_env}"
GUTCORE_ENV="${GUTCORE_ENV:-gutcore_env}"
GATEWAY_ENV="${GATEWAY_ENV:-endo-gateway}"
CONDA_BASE="${CONDA_BASE:-$(conda info --base)}"
GUTCORE_ROOT="${GUTCORE_ROOT:-$ROOT/GutCore}"

mkdir -p logs
export PYTHONPATH="$ROOT:${PYTHONPATH:-}"

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

echo "starting services..."
launch "$GNS_ENV"     backend.servers.gns_server gns
launch "$GIM_ENV"     backend.servers.gim_server gim
launch "$CGI_ENV"     backend.servers.cgi_server cgi

# GutCore is deliberately optional so existing installations keep starting
# unchanged. Once its environment and external source tree exist, it is picked
# up automatically; weight resolution is handled by the official package.
if [[ -x "$CONDA_BASE/envs/$GUTCORE_ENV/bin/python" && -d "$GUTCORE_ROOT/src/gutcore" ]]; then
  export GUTCORE_ROOT
  launch "$GUTCORE_ENV" backend.servers.gutcore_server gutcore
else
  echo "   gutcore skipped (optional; see README.md)"
fi

launch "$GATEWAY_ENV" backend.gateway            gateway

echo
echo "waiting for models to load (weights are multi-GB, this takes a while)..."
for _ in $(seq 1 120); do
  if curl -sf http://127.0.0.1:8080/api/health 2>/dev/null | grep -q '"cgi":true'; then
    break
  fi
  sleep 2
done

echo
curl -s http://127.0.0.1:8080/api/health || echo "gateway not responding — check logs/gateway.log"
echo
echo
echo "gateway  http://127.0.0.1:8080"
echo "frontend cd frontend && npm run dev   ->  http://localhost:5173"
