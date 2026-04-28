// @ts-ignore — no type declarations for irc-framework
import IRC from 'irc-framework';
import { loadNickGroups, resolveNickGroup, type NickGroupsConfig } from './nick-groups.js';

/**
 * Split arbitrary text into IRC-safe PRIVMSG payloads:
 * - no CR/LF (collapse to spaces)
 * - each chunk <= `max` bytes (default 400, well under the 512 line cap
 *   so prefix + "PRIVMSG #chan :" fits).
 */
export function chunkForIrc(text: string, max = 400): string[] {
  const oneline = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!oneline) return [];
  const out: string[] = [];
  let buf = '';
  for (const word of oneline.split(' ')) {
    if (!word) continue;
    const candidate = buf ? `${buf} ${word}` : word;
    if (Buffer.byteLength(candidate) <= max) {
      buf = candidate;
      continue;
    }
    if (buf) out.push(buf);
    if (Buffer.byteLength(word) <= max) {
      buf = word;
    } else {
      let b = Buffer.from(word);
      while (b.length > max) {
        out.push(b.subarray(0, max).toString('utf8'));
        b = b.subarray(max);
      }
      buf = b.toString('utf8');
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ---------- runtime glue ----------

type Config = {
  server: string;
  port: number;
  tls: boolean;
  nick: string;
  channel: string;
  /** Default sessionId (used when nick groups are not configured) */
  sessionId: string;
  /** Default userId (used when nick groups are not configured) */
  userId: string;
  webhookUrl: string;
  password?: string;
  /**
   * Comma-separated list of IRC nicks (case-insensitive) whose chat lines are
   * forwarded to the agent. Empty/unset = forward everyone. Set to e.g.
   * `lokvolt` so random Twitch viewers can't trigger Claude turns.
   * Legacy — superseded by nickGroups when present.
   */
  allowedNicks?: Set<string>;
  /**
   * If set, only messages that mention the bot (e.g. `@sleet1213 ...` or just
   * `sleet1213` as a token) are forwarded. Defaults to true on Twitch since
   * the bot is the broadcaster and ambient chatter shouldn't trigger turns.
   * Legacy default — groups override this per-group.
   */
  requireMention: boolean;
  /**
   * Nick groups configuration. When present, supersedes allowedNicks.
   * Each group maps nicks to a userId, sessionId, and agent config.
   */
  nickGroups?: NickGroupsConfig;
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function loadConfig(): Config {
  const channel = must('IRC_CHANNEL');
  if (!channel.startsWith('#') && !channel.startsWith('&')) {
    throw new Error('IRC_CHANNEL must start with # or &');
  }
  const rawAllow = (process.env.IRC_ALLOWED_NICKS ?? '').trim();
  const allowedNicks = rawAllow
    ? new Set(rawAllow.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean))
    : undefined;
  const requireMentionRaw = (process.env.IRC_REQUIRE_MENTION ?? 'true').trim().toLowerCase();
  const requireMention = requireMentionRaw !== 'false' && requireMentionRaw !== '0';
  // Try loading nick groups config — supersedes IRC_ALLOWED_NICKS when present
  const nickGroups = loadNickGroups() ?? undefined;
  if (nickGroups) {
    console.log(
      `[irc] nick groups loaded: ${nickGroups.groups.map((g) => `${g.name}(${g.nicks.join(',')})`).join(', ')}`,
    );
  }

  return {
    server: must('IRC_SERVER'),
    port: Number(process.env.IRC_PORT ?? 6667),
    tls: process.env.IRC_TLS === 'true',
    nick: process.env.IRC_NICK ?? 'sleet1213',
    channel,
    sessionId: process.env.IRC_SESSION_ID ?? `irc-${channel.slice(1)}`,
    userId: must('IRC_USER_ID'),
    webhookUrl: process.env.WEBHOOK_URL ?? 'http://localhost:8787',
    password: process.env.IRC_PASSWORD,
    allowedNicks,
    requireMention,
    nickGroups,
  };
}

function isMentioned(message: string, botNick: string): boolean {
  const lc = message.toLowerCase();
  const nick = botNick.toLowerCase();
  // Match `@sleet1213` or bare `sleet1213` as a word boundary.
  return new RegExp(`(^|[^a-z0-9_])@?${nick}($|[^a-z0-9_])`, 'i').test(lc);
}

async function postToWebhook(
  cfg: Config,
  msg: string,
  extra?: Record<string, unknown>,
  overrides?: { userId?: string; sessionId?: string },
): Promise<void> {
  const userId = overrides?.userId ?? cfg.userId;
  const sessionId = overrides?.sessionId ?? cfg.sessionId;
  const res = await fetch(`${cfg.webhookUrl}/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-User-ID': userId,
    },
    body: JSON.stringify({ sessionId, msg, ...extra }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`webhook ${res.status}: ${body}`);
  }
}

/**
 * Minimal SSE parser over a fetch Response body.
 */
async function* readSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) {
    throw new Error(`sse ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let dataLines: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (raw === '') {
        if (dataLines.length) {
          yield dataLines.join('\n');
          dataLines = [];
        }
        continue;
      }
      if (raw.startsWith(':')) continue;
      if (raw.startsWith('data:')) {
        dataLines.push(raw.slice(5).replace(/^ /, ''));
      }
    }
  }
}

async function streamToIrc(
  cfg: Config,
  signal: AbortSignal,
  sendPrivmsg: (text: string) => void,
  sessionOverride?: { sessionId: string; userId: string },
): Promise<void> {
  const sessionId = sessionOverride?.sessionId ?? cfg.sessionId;
  const userId = sessionOverride?.userId ?? cfg.userId;
  const url = `${cfg.webhookUrl}/sessions/${encodeURIComponent(sessionId)}/stream`;
  const headers = { 'X-User-ID': userId };

  // Chat output strategy:
  //   * `tool_call`   → post `[using TOOL]` live (progress signal)
  //   * `thinking`    → accumulate and flush per LLM iteration with
  //                     `[thinking] ...` prefix on `message_stop`
  //   * regular delta → DO NOT post per-iteration. The agent re-narrates
  //                     its plan every iteration and that "replaying"
  //                     loop was the noisy thing the operator hated. The
  //                     activity emits a polished `final_text` event at
  //                     the end carrying the SDK result string — that's
  //                     the one we post as the final reply.
  //   * `final_text`  → post the agent's final answer (one message)
  //   * `pending` is a fallback: if no `final_text` arrived (e.g. the
  //     turn was interrupted before any assistant text materialised),
  //     post the accumulated deltas at `turn_end` as best effort.
  let thinking = '';
  let pending = '';
  let postedFinal = false;
  for await (const data of readSse(url, headers, signal)) {
    let event: { type: string; text?: string; name?: string };
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.type === 'delta' && typeof event.text === 'string') {
      pending += event.text;
    } else if (event.type === 'thinking' && typeof event.text === 'string') {
      thinking += event.text;
    } else if (event.type === 'tool_call' && event.name) {
      sendPrivmsg(`[using ${event.name}]`);
    } else if (event.type === 'message_stop') {
      // End of one LLM iteration. Flush accumulated thinking, drop the
      // iteration's narrative text (avoids the "replay" feel).
      if (thinking.trim()) {
        for (const chunk of chunkForIrc(`[thinking] ${thinking}`)) {
          sendPrivmsg(chunk);
        }
        thinking = '';
      }
      pending = '';
    } else if (event.type === 'final_text' && typeof event.text === 'string') {
      const final = event.text.trim();
      if (final) {
        for (const chunk of chunkForIrc(final)) sendPrivmsg(chunk);
        postedFinal = true;
      }
      pending = '';
    } else if (event.type === 'turn_end') {
      if (!postedFinal && pending.trim()) {
        for (const chunk of chunkForIrc(pending)) sendPrivmsg(chunk);
      }
      thinking = '';
      pending = '';
      postedFinal = false;
    }
  }
}

/**
 * Tiny HTTP server on the IRC bridge for echo requests.
 * POST /echo { "text": "..." } → sends text to the IRC channel.
 * Used by the Temporal scheduler to surface scheduled prompts in chat.
 */
async function startEchoServer(
  sendPrivmsg: (text: string) => void,
  port: number,
): Promise<void> {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/echo') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { text } = JSON.parse(body);
        if (typeof text === 'string' && text.trim()) {
          for (const chunk of chunkForIrc(text)) sendPrivmsg(chunk);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"bad json"}');
      }
    } else {
      res.writeHead(404);
      res.end('{"error":"not found"}');
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[irc] echo server listening on 127.0.0.1:${port}`);
  });
}

async function main() {
  const cfg = loadConfig();
  console.log(
    `[irc] connecting to ${cfg.server}:${cfg.port} as ${cfg.nick}, joining ${cfg.channel}`,
  );

  // Wait for the webhook to be reachable before connecting to IRC — but
  // do it via a side-effect-free GET, NOT a POST /message. The earlier
  // implementation primed the session with `[irc bridge online ...]` as
  // a synthetic user message, which the worker dutifully forwarded to
  // the agent on every bridge restart, causing the agent to wake up and
  // reply to a phantom request from "lokvolt". GET /sessions only needs
  // the X-User-ID header we already have and has no side effects.
  // Wait for the webhook to be reachable. Use a GET on the messages
  // endpoint (returns empty 401 without X-User-ID but proves the server
  // is up). The old /sessions endpoint was removed with the web frontend.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${cfg.webhookUrl}/sessions/_health/messages`, {
        headers: { 'X-User-ID': cfg.userId },
      });
      // Any response (even 404) means the server is up.
      break;
    } catch (err) {
      console.error(
        `[irc] webhook health check attempt ${attempt} failed:`,
        (err as Error).message,
      );
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2000, 15000)));
    }
  }

  const client = new IRC.Client();

  client.connect({
    host: cfg.server,
    port: cfg.port,
    tls: cfg.tls,
    nick: cfg.nick,
    username: cfg.nick,
    gecos: cfg.nick,
    password: cfg.password || undefined,
    auto_reconnect: true,
    auto_reconnect_wait: 4000,
    auto_reconnect_max_retries: 0, // unlimited
  });

  client.on('registered', () => {
    console.log('[irc] registered, joining', cfg.channel);
    client.join(cfg.channel);
  });

  client.on('join', (event: { channel: string; nick: string }) => {
    if (event.nick === cfg.nick) {
      console.log('[irc] joined', event.channel);
    }
  });

  client.on(
    'privmsg',
    (event: { target: string; nick: string; message: string }) => {
      if (event.target !== cfg.channel) return;
      // Ignore own messages and any stale instances with the same base nick
      const baseNick = (process.env.IRC_NICK ?? 'sleet1213');
      if (event.nick.startsWith(baseNick)) return;

      // --- Nick groups path (new) ---
      if (cfg.nickGroups) {
        const group = resolveNickGroup(event.nick, cfg.nickGroups);
        if (!group) return; // nick not in any group, drop silently

        // Per-group mention filter
        if (group.requireMention && !isMentioned(event.message, cfg.nick)) {
          return;
        }

        const payload = `${event.nick}: ${event.message}`;
        postToWebhook(
          cfg,
          payload,
          { agentConfig: group.agentConfig },
          { userId: group.userId, sessionId: group.sessionId },
        ).catch((err) =>
          console.error(`[irc] webhook post failed (group=${group.name}):`, (err as Error).message),
        );
        return;
      }

      // --- Legacy path (IRC_ALLOWED_NICKS flat set) ---
      // Allowlist filter: if IRC_ALLOWED_NICKS is set, only those nicks trigger
      // an agent turn. Other lines are silently ignored (no webhook call).
      if (cfg.allowedNicks && !cfg.allowedNicks.has(event.nick.toLowerCase())) {
        return;
      }
      // Mention filter: on Twitch the bot is the broadcaster, so ambient
      // chatter shouldn't trigger turns. Require the bot's nick to appear
      // in the message text (with or without `@`).
      if (cfg.requireMention && !isMentioned(event.message, cfg.nick)) {
        return;
      }
      const payload = `${event.nick}: ${event.message}`;
      postToWebhook(cfg, payload).catch((err) =>
        console.error('[irc] webhook post failed:', (err as Error).message),
      );
    },
  );

  client.on('reconnecting', () => {
    console.log('[irc] reconnecting...');
  });

  client.on('close', () => {
    console.error('[irc] connection closed');
  });

  const sendPrivmsg = (text: string) => {
    client.say(cfg.channel, text);
  };

  // Start the echo server so the scheduler can surface prompts in chat.
  const echoPort = Number(process.env.IRC_ECHO_PORT ?? 8790);
  startEchoServer(sendPrivmsg, echoPort).catch((err) =>
    console.error('[irc] echo server failed:', (err as Error).message),
  );

  const abort = new AbortController();
  process.on('SIGINT', () => {
    abort.abort();
    client.quit('shutting down');
    process.exit(0);
  });

  // Collect unique sessions to stream from. Deduplicate by sessionId —
  // when multiple groups share a session (shared-session model), we only
  // want ONE SSE stream per session, otherwise every reply gets echoed
  // once per group.
  type StreamTarget = { sessionId: string; userId: string };
  const streamTargets: StreamTarget[] = [];

  if (cfg.nickGroups) {
    const seen = new Set<string>();
    for (const g of cfg.nickGroups.groups) {
      if (!seen.has(g.sessionId)) {
        seen.add(g.sessionId);
        streamTargets.push({ sessionId: g.sessionId, userId: g.userId });
      }
    }
  } else {
    streamTargets.push({ sessionId: cfg.sessionId, userId: cfg.userId });
  }

  // Stream webhook responses back to IRC — one loop per session target.
  // All run concurrently; each reconnects independently on error.
  async function runStreamLoop(target: StreamTarget) {
    while (!abort.signal.aborted) {
      try {
        await streamToIrc(cfg, abort.signal, sendPrivmsg, target);
      } catch (err) {
        if (abort.signal.aborted) return;
        console.error(
          `[irc] stream error (session=${target.sessionId}):`,
          (err as Error).message,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  await Promise.all(streamTargets.map(runStreamLoop));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
