#!/bin/sh
# Start webhook and worker processes
# If either exits, the other is killed and the container restarts

node --loader ts-node/esm src/webhook.ts &
PID_WEBHOOK=$!

node --loader ts-node/esm src/worker.ts &
PID_WORKER=$!

# Trap to clean up on exit
trap 'kill $PID_WEBHOOK $PID_WORKER 2>/dev/null; exit' INT TERM

# Poll until one exits
while kill -0 $PID_WEBHOOK 2>/dev/null && kill -0 $PID_WORKER 2>/dev/null; do
  sleep 1
done

echo "A process exited, shutting down..."
kill $PID_WEBHOOK $PID_WORKER 2>/dev/null
exit 1
