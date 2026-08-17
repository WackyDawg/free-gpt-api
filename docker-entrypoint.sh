#!/bin/bash
set -e

# Hosts that only expose secrets as environment variables (and Render, if you
# would rather not use a Secret File) can pass the cookie export base64-encoded.
# Materialise it somewhere the app user can read, then point the app at it.
if [ -n "$CHATGPT_COOKIES_B64" ]; then
  COOKIE_FILE=/tmp/chatgpt.cookies.json
  printf '%s' "$CHATGPT_COOKIES_B64" | base64 -d > "$COOKIE_FILE"
  chmod 600 "$COOKIE_FILE"
  export CHATGPT_COOKIES_PATH="$COOKIE_FILE"
  echo -e "\e[92m===>\e[0m [cookies] decoded $(wc -c < "$COOKIE_FILE") bytes to $COOKIE_FILE"
fi

# Fail loudly here rather than 90 seconds later on a Cloudflare login wall.
COOKIE_PATH="${CHATGPT_COOKIES_PATH:-src/cookies/chatgpt.com.cookies.json}"
if [ ! -r "$COOKIE_PATH" ]; then
  echo -e "\e[93m===>\e[0m [cookies] not readable at $COOKIE_PATH — the proxy will start but every request will fail authentication."
  echo -e "\e[93m===>\e[0m [cookies] mount a Secret File there, or set CHATGPT_COOKIES_B64."
fi

echo -e "\e[92m===>\e[0m [display] starting Xvfb on :99..."
mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT

# Wait for the display socket instead of guessing at a sleep: a cold container
# on a busy host can take longer than the two seconds this used to assume.
for _ in $(seq 1 50); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.2
done
if [ ! -e /tmp/.X11-unix/X99 ]; then
  echo -e "\e[91m===>\e[0m [display] Xvfb did not come up on :99" >&2
  exit 1
fi
echo -e "\e[92m===>\e[0m [display] ready (pid $XVFB_PID)"

echo -e "\e[94m===>\e[0m [proxy] starting on port ${PORT:-3000}..."
# exec node, not npm: npm does not forward SIGTERM to the server it spawned, so
# a redeploy would hard-kill the process group with Chromium still attached.
exec node src/server.js
