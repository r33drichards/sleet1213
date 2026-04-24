#!/bin/sh
# Wrapper to run Claude Code binary as non-root user (bypassPermissions requires non-root)
exec su ted -s /bin/sh -c "exec /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude $*"
