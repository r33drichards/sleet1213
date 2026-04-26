---
name: sleet1213-self-admin
description: Use when you (sleet1213) need to admin this EC2 host — restart your own services, restart the bot or stream, edit your own code, triage audio/video, or check service health. Catalogs the systemd units (yours under user-systemd; the bot/stream/event-bridge under system-systemd with passwordless sudo) and the source-edit-and-restart workflow for your own repo at /home/ubuntu/sleet1213/.
---

# Admin of this host

## Service catalog

**Yours** (user-level, `systemctl --user`):

| Unit | Listens on | What |
|---|---|---|
| `sleet1213-temporal.service` | `127.0.0.1:7233`, UI `:8233` | Temporal dev server (workflow engine) |
| `sleet1213-webhook.service` | `:8787` | Hono HTTP API + SSE delta stream |
| `sleet1213-worker.service` | (Temporal client) | Claude Agent SDK worker (this is **you**) |
| `sleet1213-irc.service` | (outbound to twitch IRC) | Twitch chat bridge |

**Host** (system-level, `sudo systemctl`, you have NOPASSWD on these):

| Unit | What |
|---|---|
| `btone-bot.service` | Minecraft client (portablemc + btone-mod-c Fabric mod) |
| `xorg-headless.service` | Nvidia virtual display `:99` for the client |
| `btone-stream.service` | ffmpeg → Twitch RTMP |
| `pulse-game.service` | PulseAudio sink for game audio capture |
| `event-bridge.service` | SSE → webhook bridge from the bot |
| `litellm.service` | Legacy LiteLLM Bedrock proxy (you don't use it; openclaw did) |

## Restart anything

```bash
# Yours — DO NOT use sudo (it goes to root's user systemd, not yours)
systemctl --user restart sleet1213-irc
journalctl --user -u sleet1213-worker --since '5 minutes ago' --no-pager

# Host services (sudo passwordless)
sudo systemctl restart btone-stream
sudo systemctl restart btone-bot
sudo journalctl -u btone-stream -n 50 --no-pager
```

If you `systemctl --user restart sleet1213-worker` while processing a
chat message, you kill the in-flight LLM call. Temporal retries the
activity automatically — safe, just produces a duplicate reply.

## Health snapshot

```bash
for s in sleet1213-temporal sleet1213-webhook sleet1213-worker sleet1213-irc; do
  printf '%-30s %s\n' "$s" "$(systemctl --user is-active $s)"
done
for s in btone-bot btone-stream pulse-game event-bridge; do
  printf '%-30s %s\n' "$s" "$(systemctl is-active $s)"
done
```

## Stream audio path

The Twitch stream captures the **MC client's actual game sound**:

1. `snd-aloop` kernel module → virtual ALSA card `Loopback`
2. `~btone/.asoundrc` routes MC's default ALSA output to `hw:Loopback,0,0`
3. ffmpeg in `btone-stream.service` reads from `hw:Loopback,1,0`

When chat reports "no sound on stream":

```bash
lsmod | grep snd_aloop
aplay -l | grep Loopback
arecord -l | grep Loopback
sudo journalctl -u btone-stream -n 30 --no-pager | grep -iE 'alsa|audio|sample_fmt'
```

- **Loopback not loaded** → `sudo modprobe snd-aloop && sudo systemctl restart btone-stream`
- **MC not emitting sound** → `sudo journalctl -u btone-bot | grep -i 'soundsystem\|openal'`. If "Failed to open OpenAL device" → `sudo systemctl restart btone-bot`.
- **Stream up but silent** → `sudo systemctl restart btone-stream`.

**Never read `/etc/btone-stream/env`** — Twitch stream key lives there.

## Editing your own code

Your repo is [r33drichards/sleet1213](https://github.com/r33drichards/sleet1213)
checked out at `/home/ubuntu/sleet1213/`. Source-edit + restart, no
build step (we run through `ts-node/esm` directly):

```bash
cd /home/ubuntu/sleet1213
# edit src/<file>.ts ...
git add -p && git commit -m "..." && git push origin master
systemctl --user restart sleet1213-worker   # or webhook / irc as appropriate
```

`src/` layout:

| File | What |
|---|---|
| `src/activities.ts` | Temporal activities: `streamClaude` (Agent SDK), `persistTurn`, `generateTitle` |
| `src/workflows.ts` | `chatSession` Temporal workflow — inbox + history + signal handlers |
| `src/webhook.ts` | Hono HTTP API (`/message`, `/sessions/:id/messages`, `/sessions/:id/stream`) |
| `src/irc-bridge.ts` | Twitch IRC ↔ webhook bridge (allowedNicks + requireMention filters) |
| `src/inbox.ts` | `drainInbox` — coalesce queued messages into one user turn |
| `src/memory-mcp.ts` | In-process MCP for working/short_term/long_term memory CRUD |
| `src/publish.ts` | Redis Streams: `publishDelta` / `publishThinking` / `publishToolCall` / `publishTurnEnd` |
| `src/db.ts` | Postgres pool + schema |
| `src/signals.ts` | Temporal signal/query defs |
| `src/worker.ts` | Temporal worker bootstrap |

## Adding / editing skills

Skills are auto-discovered from `ted-plugin/skills/<name>/SKILL.md`.
Just write a new file with YAML front matter:

```markdown
---
name: my-skill
description: When the agent should pick this skill. The SDK uses this for selection.
---

# My skill body...
```

No restart needed — skills are read fresh per turn. Push your edit
back to GitHub so it survives a re-clone.

## .env

`/home/ubuntu/sleet1213/.env` (mode 0600). Key entries:

- `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION=us-west-2`,
  `ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0` — auth
  via the EC2 instance profile, no API key needed.
- `IRC_PASSWORD=oauth:...` — Twitch token. If it expires, refresh via
  https://twitchtokengenerator.com (Bot Chat Token preset).
- `IRC_ALLOWED_NICKS=lokvolt`, `IRC_REQUIRE_MENTION=true` — only the
  operator can trigger your turns; ambient viewers can't.
- `CLAUDE_CODE_PATH` — path to the glibc claude binary
  (`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`).
- `CLAUDE_CWD` — your working dir (`/home/ubuntu/sleet1213`).
- `SLEET1213_PLUGIN_DIR` — defaults to `/home/ubuntu/sleet1213/ted-plugin`.

After editing `.env`: `systemctl --user restart sleet1213-worker
sleet1213-webhook sleet1213-irc`.

## Pitfalls

- **Don't `sudo systemctl ...` for sleet1213-* units** — that hits
  root's user-systemd which has none of your units. Use
  `systemctl --user ...`.
- **Don't break linger.** `loginctl show-user ubuntu | grep Linger=yes`
  must stay yes — without it your services die when the last SSH
  session closes.
- **Don't run `npm run build` or `tsc`.** Everything runs through
  `ts-node/esm` from `src/`. A stray `dist/` produces no help and
  some confusion.
- **Pulling upstream from r33drichards/ted** will revert your
  `cwd: process.env.CLAUDE_CWD ?? ...` and `PLUGIN_DIR: process.env.SLEET1213_PLUGIN_DIR ?? ...`
  patches. If you re-pull, re-apply both — without them the Agent SDK
  errors with a misleading "Claude Code native binary not found".

## Where you came from

This box ran [openclaw](https://github.com/openclaw/openclaw) before
sleet1213. Migrated 2026-04-26 because openclaw had recurring issues:
Bonjour CIAO crash loop, Zod 4 schema deadlock, plugin-discovery CPU
loop, silent IRC zombie connections, agent runs blocking chat for
minutes. Old state at `/home/ubuntu/.archive-openclaw-2026-04-26/.openclaw`
if reference is ever needed.
