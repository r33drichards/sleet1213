#!/bin/sh
# Start all three processes: webhook, worker, and IRC bridge
# If any process exits, kill the others and exit

node --loader ts-node/esm src/webhook.ts &
PID_WEBHOOK=$!

node --loader ts-node/esm src/worker.ts &
PID_WORKER=$!

# Give webhook and worker a moment to start before IRC bridge tries to prime
sleep 5

node --loader ts-node/esm src/irc-bridge.ts &
PID_IRC=$!

# Wait for any process to exit
wait -n $PID_WEBHOOK $PID_WORKER $PID_IRC
EXIT_CODE=$?

echo "A process exited with code $EXIT_CODE, shutting down..."
kill $PID_WEBHOOK $PID_WORKER $PID_IRC 2>/dev/null
exit $EXIT_CODE
