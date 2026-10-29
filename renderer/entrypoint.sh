#!/bin/bash
# One container, two processes: the Remotion renderer on the loopback and the
# workbench on the public port. Both are started here so the renderer can never
# outlive the app that owns its data directory, and so `docker logs` has one
# stream for both.
#
# The renderer must stay on 127.0.0.1: its REST API has no authentication and
# would otherwise be a public "burn my Pexels quota" button. Only the workbench
# port is published.
set -uo pipefail

PUBLIC_PORT="${PUBLIC_PORT:-3123}"
RENDERER_PORT="${VIDEO_RENDERER_PORT:-3125}"

cd /app || exit 1
PORT="$RENDERER_PORT" node dist/index.js >> /app/server.log 2>&1 &
renderer=$!

cd /opt/workbench || exit 1
/opt/venv/bin/uvicorn server.main:app --host 0.0.0.0 --port "$PUBLIC_PORT" &
app=$!

shutdown() {
  kill -TERM "$renderer" "$app" 2>/dev/null
}
trap shutdown TERM INT

# If either process dies the container should die with it: a workbench with no
# renderer still serves four tabs, but a renderer with no workbench is
# unreachable and would leave a zombie holding 300 MB of Chrome.
wait -n "$renderer" "$app"
status=$?
shutdown
wait
exit "$status"
