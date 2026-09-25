#!/bin/sh
set -e

echo "[entrypoint] syncing database schema..."
node_modules/.bin/drizzle-kit push --force

echo "[entrypoint] starting worker..."
node_modules/.bin/tsx src/worker/index.ts &
WORKER_PID=$!

echo "[entrypoint] starting preview supervisor..."
node_modules/.bin/tsx src/preview/index.ts &
PREVIEW_PID=$!

echo "[entrypoint] starting web..."
node server.js &
WEB_PID=$!

trap 'kill $WORKER_PID $PREVIEW_PID $WEB_PID 2>/dev/null; exit 0' TERM INT

# If any process dies, exit so the orchestrator restarts the container.
# (busybox sh has no `wait -n`, so poll the pids)
while kill -0 "$WORKER_PID" 2>/dev/null && kill -0 "$PREVIEW_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 5
done

echo "[entrypoint] a process exited — shutting down container"
kill $WORKER_PID $PREVIEW_PID $WEB_PID 2>/dev/null || true
exit 1
