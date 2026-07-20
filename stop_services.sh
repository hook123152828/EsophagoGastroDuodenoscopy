#!/usr/bin/env bash
#
# Shut down every service started by start_services.sh (the four backend
# processes) plus the Vite dev server for the UI.

set -u

kill_by() {
  local label="$1" pattern="$2"
  local pids
  pids=$(pgrep -f "$pattern" || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    echo "Stopped ${label}: PID ${pids//$'\n'/ }"
  else
    echo "${label}: not running"
  fi
}

kill_by "Gateway (:8080)" "backend/gateway.py"
kill_by "GNS (:8000)"     "backend/gns_server.py"
kill_by "CGI (:8002)"     "CGI/cgi_server.py"
kill_by "GIM (:8001)"     "GIM/main.py"
kill_by "Frontend (Vite :2026)" "vite"

# Give them a moment, then force-kill anything still holding the ports.
sleep 1
for port in 8080 8000 8002 8001 2026; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null
    echo "Force-killed leftover on port ${port}: PID ${pids//$'\n'/ }"
  fi
done

echo "All services stopped."
