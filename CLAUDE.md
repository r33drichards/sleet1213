# sleet1213

Durable Claude chat agent for the `sleet1213` Twitch channel — fork of [r33drichards/ted](https://github.com/r33drichards/ted). Powered by the Claude Agent SDK, Temporal workflows, and an IRC bridge that connects directly to Twitch chat. **No web frontend** — all interaction is through IRC/Twitch chat only.

The agent is the brain behind a live Minecraft bot stream — it talks to the operator (`lokvolt`) and public viewers in Twitch chat and drives `btone-bot` (a headless Minecraft client) over a local RPC bridge.

## Architecture

- `src/activities.ts` — Temporal activities: `streamClaude` (Agent SDK query), `persistTurn`, `generateTitle`
- `src/memory-mcp.ts` — In-process MCP server for memory CRUD (working/short_term/long_term)
- `src/workflows.ts` — Temporal chatSession workflow
- `src/webhook.ts` — Hono HTTP API (message ingestion, SSE streaming)
- `src/irc-bridge.ts` — IRC bridge (InspIRCd on Railway private network)
- `src/nick-groups.ts` — Nick-to-group resolver, per-group agent config
- `src/db.ts` — Postgres schema + CRUD (messages, sessions, mcp_servers, memories)
- `src/publish.ts` — Redis Streams for SSE deltas (delta, thinking, tool_call, turn_end)
- `.claude/skills/` — Agent skills (auto-discovered, self-editable)

## Nick Groups & Tool Restrictions

Access control is enforced via nick groups defined in `/etc/sleet1213/nick-groups.json`. Each group maps a set of IRC nicks to a specific agent configuration with restricted tools.

Tool restrictions are enforced via the SDK `tools` option (controls which built-in tools exist) and `allowedTools` (auto-approves those tools without permission prompts). Both are set from `agentConfig.allowedTools` in the nick group config.

### Admin (lokvolt)

Full system access — can drive the EC2 host, systemd services, build code, and self-edit skills:

- **Built-in tools:** Read, Write, Edit, Glob, Grep, Bash, WebSearch, WebFetch, Skill, Agent, TodoWrite, NotebookEdit
- **MCP tools:** `mcp__*` (memory MCP, user-configured MCP servers)
- **Plugins:** REPO + LOCAL skill directories
- **Session:** `irc-sleet1213`

### Public (everyone else)

Restricted to MCP tools only — can use `mcp-js` to edit and create skills, schedules, memory, and interact with Minecraft:

- **Built-in tools:** None (only `mcp__*` pattern)
- **MCP tools:** `mcp-js` (JavaScript runtime for creating skills, managing schedules, memory CRUD, and Minecraft RPC interaction)
- **Plugins:** Disabled
- **Session:** `irc-sleet1213-public`

## Chat Ingress Filters

The IRC bridge routes messages through nick groups (defined in `/etc/sleet1213/nick-groups.json`):

- Admin nicks (e.g. `lokvolt`) get full agent capabilities
- All other nicks (`*` wildcard) get the public restricted agent
- `requireMention: true` means messages must mention `@sleet1213` to trigger an agent turn

Legacy fallback: `IRC_ALLOWED_NICKS` / `IRC_REQUIRE_MENTION` env vars are used if no nick-groups config exists.

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
