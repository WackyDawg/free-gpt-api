#!/bin/bash
set -e

echo -e "\e[92m===>\e[0m [display] starting Xvfb on :99..."
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 2
echo -e "\e[92m===>\e[0m [display] ready (pid $XVFB_PID)"

echo -e "\e[94m===>\e[0m [proxy] starting on port ${PORT:-3000}..."
exec npm start