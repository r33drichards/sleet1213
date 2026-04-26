# sleet1213

Durable Claude chat agent for the `sleet1213` Twitch channel — fork of [r33drichards/ted](https://github.com/r33drichards/ted). Powered by the Claude Agent SDK, Temporal workflows, and an IRC bridge that connects directly to Twitch chat.

The agent is the brain behind a live Minecraft bot stream — it talks to the operator (`lokvolt`) in Twitch chat and drives `btone-bot` (a headless Minecraft client) over a local RPC bridge.

## Architecture

- `src/activities.ts` — Temporal activities: `streamClaude` (Agent SDK query), `persistTurn`, `generateTitle`
- `src/memory-mcp.ts` — In-process MCP server for memory CRUD (working/short_term/long_term)
- `src/workflows.ts` — Temporal chatSession workflow
- `src/webhook.ts` — Hono HTTP API (message ingestion, sessions, SSE streaming)
- `src/irc-bridge.ts` — IRC bridge (InspIRCd on Railway private network)
- `src/db.ts` — Postgres schema + CRUD (messages, sessions, mcp_servers, memories)
- `src/publish.ts` — Redis Streams for SSE deltas (delta, thinking, tool_call, turn_end)
- `.claude/skills/` — Agent skills (auto-discovered, self-editable)

## Agent Capabilities

The agent uses the Claude Agent SDK with these tools enabled (vs the upstream `ted` defaults — sleet1213 has the full Bash + filesystem set so the agent can drive systemd, build code, and self-edit skills on the EC2 host):

- Read, Write, Edit, Glob, Grep (filesystem)
- Bash (full shell access — agent runs as `ubuntu` on the EC2 host with sudoers entries for the bot/stream services)
- WebSearch, WebFetch (web)
- TodoWrite, NotebookEdit
- Skill (self-editable skills in `.claude/skills/`)
- Agent (subagents)
- MCP tools (`mcp__*`, including the in-process `sleet1213` memory MCP)

## Chat ingress filters

The IRC bridge has two filters meant for a public Twitch channel:

- `IRC_ALLOWED_NICKS` (comma-separated, case-insensitive) — only listed nicks trigger an agent turn. Set to `lokvolt` so random chat viewers can't direct the bot. Empty/unset = forward everyone.
- `IRC_REQUIRE_MENTION` (default `true`) — only forward messages that mention the bot's nick (`@sleet1213` or bare `sleet1213`). Ambient chatter is dropped without a webhook call.

## E2E Testing

```
node e2e/irc-e2e.mjs [--message "text"] [--timeout 90]
```

## Deploy

Push to master. Railway auto-deploys `ted` and `ted-irc-bridge`.

After workflow-shape changes, terminate the old workflow:
```
railway ssh -s ted -- 'node -e "
const { Connection, Client } = require(\"@temporalio/client\");
(async () => {
  const conn = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS });
  const client = new Client({ connection: conn });
  await client.workflow.getHandle(\"chat:irc-ted\").terminate(\"deploy reset\");
  process.exit(0);
})();
"'
```
