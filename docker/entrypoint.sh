#!/bin/sh
set -e

echo "[entrypoint] syncing database schema..."
node_modules/.bin/drizzle-kit push --force

echo "[entrypoint] starting worker..."
node_modules/.bin/tsx src/worker/index.ts &
WORKER_PID=$!

echo "[entrypoint] starting web..."
node server.js &
WEB_PID=$!

# If either process dies, exit so the orchestrator restarts the container.
trap 'kill $WORKER_PID $WEB_PID 2>/dev/null' TERM INT
wait -n $WORKER_PID $WEB_PID
EXIT_CODE=$?
kill $WORKER_PID $WEB_PID 2>/dev/null || true
exit $EXIT_CODE
