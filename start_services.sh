#!/usr/bin/env bash

set -u

mkdir -p logs

/home/harry/miniconda3/envs/GNS/bin/python backend/gns_server.py >logs/gns.log 2>&1 &
gns_pid=$!
echo "GNS started: PID ${gns_pid}, port 8000"

/home/harry/miniconda3/envs/IM_web/bin/python CGI/cgi_server.py >logs/cgi.log 2>&1 &
cgi_pid=$!
echo "CGI started: PID ${cgi_pid}, port 8002"

/home/harry/miniconda3/envs/IM_web/bin/python GIM/main.py >logs/gim.log 2>&1 &
gim_pid=$!
echo "GIM started: PID ${gim_pid}, port 8001"

# Give the model services a moment to begin loading before starting the gateway.
sleep 3

/home/harry/miniconda3/bin/python backend/gateway.py >logs/gateway.log 2>&1 &
gateway_pid=$!
echo "Gateway started: PID ${gateway_pid}, port 8080"

# Frontend (Vite dev server). Node 20 lives under nvm; put it on PATH so the
# right node/npm is used regardless of the caller's shell.
export PATH="$HOME/.local/bin:$PATH"
(cd UI && npm run dev >../logs/frontend.log 2>&1) &
frontend_pid=$!
echo "Frontend started: PID ${frontend_pid}, port 2026 (http://localhost:2026)"
