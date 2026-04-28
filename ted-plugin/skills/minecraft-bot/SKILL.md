---
name: minecraft-bot
description: Drive the live Minecraft Java bot (BotEC2) on this host via its on-host JSON-RPC bridge. Use when chat asks to move, mine, look, use chests, or report bot state. The bot is a real Minecraft client connected to centerbeam.proxy.rlwy.net:40387 — actions persist on the multiplayer server and stream live at https://twitch.tv/sleet1213.
---

# Driving BotEC2 via RPC

The Minecraft client (`btone-mod-c` Fabric mod on portablemc) exposes
~50 JSON-RPC methods over HTTP at `127.0.0.1:25591`. The wrapper
`/var/lib/btone/source/bin/btone-cli` reads the bridge token from
`/var/lib/btone/config/btone-bridge.json` — use it as your one-line
client:

```bash
/var/lib/btone/source/bin/btone-cli <method> [--params '<json>']
```

## Discover before guessing

Don't make up method names or param shapes — the mod is the source of truth:

```bash
/var/lib/btone/source/bin/btone-cli list                  # one-line summary of every method
/var/lib/btone/source/bin/btone-cli describe player.state # full param + return schema
```

## Meteor modules vs RPC

**For automation/background tasks** (auto-craft, auto-eat, flee from danger, inventory management):
- ✅ **Create a Meteor module** (see `btone-mod-capabilities` skill)
- Modules run on the game tick loop with direct client access
- More reliable for GUI interactions (crafting, containers, inventory)
- Example: `AutoCraftBread`, `EnsureFoodInHotbar`, `RunAwayFromDanger`

**For one-off commands or external orchestration** (pathfind, report state, chat):
- ✅ **Use RPC via btone-cli**
- Better for reactive commands triggered by Twitch chat
- Vision/state queries that you need to inspect
- Example: `player.state`, `baritone.goto`, `world.screenshot`

## Common RPC operations

```bash
# State (alive? hp? where?)
/var/lib/btone/source/bin/btone-cli player.state | jq '{inWorld, name, pos: .blockPos, hp: .health, food}'

# In-game chat (NOT Twitch chat — these are different worlds)
/var/lib/btone/source/bin/btone-cli chat.send --params '{"text":"hi from sleet"}'
/var/lib/btone/source/bin/btone-cli chat.recent --params '{"limit":10}'

# Pathfind (Baritone — the autopilot)
/var/lib/btone/source/bin/btone-cli baritone.goto --params '{"x":1014,"y":69,"z":827}'
/var/lib/btone/source/bin/btone-cli baritone.command --params '{"text":"mine 1 minecraft:stone"}'
/var/lib/btone/source/bin/btone-cli baritone.command --params '{"text":"stop"}'

# See the world (returns base64 PNG + annotated entity/block coords)
/var/lib/btone/source/bin/btone-cli world.screenshot --params '{"width":640}'

# Inventory + chests
/var/lib/btone/source/bin/btone-cli player.inventory | jq '[.main[] | select(.id != "minecraft:air")]'
/var/lib/btone/source/bin/btone-cli container.open --params '{"x":1012,"y":69,"z":826}'
/var/lib/btone/source/bin/btone-cli container.state
/var/lib/btone/source/bin/btone-cli container.close

# Toggle Meteor modules (auto-behaviors)
/var/lib/btone/source/bin/btone-cli meteor.toggle --params '{"name":"auto-craft-bread","enable":true}'
/var/lib/btone/source/bin/btone-cli meteor.list  # see all available modules

# Recover from death
/var/lib/btone/source/bin/btone-cli player.respawn
```

## Camp (the bot's home base)

| Spot | Coords |
|---|---|
| Camp stand (home) | `(1014, 69, 827)` |
| LOOT chest (armor, totems, ender pearls) | `(1012, 69, 826)` |
| SUPPLY chest (cobble + iron pickaxes) | `(1012, 70, 826)` |
| DROP chest (mined cobble dumps here first) | `(1014, 69, 826)` |
| OVERFLOW chest (wheat, seeds, secondary cobble) | `(1014, 70, 826)` |
| Crafting table | `(1011, 69, 828)` |
| Camp farm plot (`baritone.command "farm"`) | `x=1001-1007, z=818-825, y=69` |
| Spawn area (after death) | around `(450, 70, 830)` |
| Bridge-east waypoint | `(1007, 68, 829)` |

When the operator names a new location, save it to a fresh `coords.md`
in your workspace via the Write tool so it survives across turns.

## Critical gotchas

- **`baritone.mine` deadlocks the JVM client thread on this build.**
  After it deadlocks, every subsequent RPC returns `TimeoutException`
  forever. **Always use `baritone.command "mine ..."` instead** — it
  runs on a worker thread.
- **Two-hop the spawn ↔ camp axis.** Single-hopping
  `baritone.goto camp-from-spawn` drowns the bot in deep water mid-route.
  Always go via the bridge-east waypoint `(1007, 68, 829)`.
- **Spawn protection silently no-ops** `world.place_block` etc. within
  ~30 blocks of server spawn. Walk away first.
- **`container.open` requires adjacency** (≤5 blocks). `baritone.goto`
  to within range first.

## Vision before guessing

If asked to find a building or check what's around: take a 4-direction
panorama with `world.screenshot` (yaw 0 / 90 / 180 / 270). The response
includes `annotations.entities` and `annotations.blocks` with on-screen
pixel + world coords — chain *"I see a chest at (444, 79, 850)"* into
`container.open(444, 79, 850)`.

## Self-rescue

If the bot is stuck (basalt pocket, bedrock layer, lava trap), it's
your problem to solve via RPC — don't ask the operator to physically
free it. The RPC surface gives you `baritone.command "stop"`, mining
adjacent blocks, `world.place_block`, `player.pillar_up`, hotbar
swaps. Worst case: walk into lava with planks (Your-Items-Are-Safe
insurance) and recover from spawn.

Default reaction to `inWorld:true, health:0.0`: `player.respawn`, then
`baritone.goto` to the death coords (visible in `chat.recent`) before
the ~5min despawn window closes.

## Don't

- Promise you "saw" something without actually calling
  `world.screenshot` or `world.blocks_around`.
- Claim you posted in chat without verifying the response was `{ok:true}`.
- Read or write `/etc/btone-stream/env` or `/etc/btone-bot.env` —
  Twitch stream key + tokens live there. You don't need them.
- Try to install new mods. Tell the operator instead.

For service-level admin (restart MC, restart stream, your own
services, code changes), see the **sleet1213-self-admin** skill.
