// @ts-ignore — no type declarations for irc-framework
import IRC from 'irc-framework';

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
  sessionId: string;
  userId: string;
  webhookUrl: string;
  password?: string;
  /**
   * Comma-separated list of IRC nicks (case-insensitive) whose chat lines are
   * forwarded to the agent. Empty/unset = forward everyone. Set to e.g.
   * `lokvolt` so random Twitch viewers can't trigger Claude turns.
   */
  allowedNicks?: Set<string>;
  /**
   * If set, only messages that mention the bot (e.g. `@sleet1213 ...` or just
   * `sleet1213` as a token) are forwarded. Defaults to true on Twitch since
   * the bot is the broadcaster and ambient chatter shouldn't trigger turns.
   */
  requireMention: boolean;
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
): Promise<void> {
  const res = await fetch(`${cfg.webhookUrl}/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-User-ID': cfg.userId,
    },
    body: JSON.stringify({ sessionId: cfg.sessionId, msg, ...extra }),
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
): Promise<void> {
  const url = `${cfg.webhookUrl}/sessions/${encodeURIComponent(cfg.sessionId)}/stream`;
  const headers = { 'X-User-ID': cfg.userId };

  let thinking = '';
  let pending = '';
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
    } else if (event.type === 'turn_end') {
      if (thinking.trim()) {
        for (const chunk of chunkForIrc(`[thinking] ${thinking}`)) {
          sendPrivmsg(chunk);
        }
      }
      if (pending.trim()) {
        for (const chunk of chunkForIrc(pending)) {
          sendPrivmsg(chunk);
        }
      }
      thinking = '';
      pending = '';
    }
  }
}

async function main() {
  const cfg = loadConfig();
  console.log(
    `[irc] connecting to ${cfg.server}:${cfg.port} as ${cfg.nick}, joining ${cfg.channel}`,
  );

  // Prime the session before connecting to IRC — retry until the webhook is
  // reachable so the bridge survives being started before the ted service.
  for (let attempt = 1; ; attempt++) {
    try {
      await postToWebhook(cfg, `[irc bridge online in ${cfg.channel}]`);
      break;
    } catch (err) {
      console.error(
        `[irc] prime attempt ${attempt} failed:`,
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

  const abort = new AbortController();
  process.on('SIGINT', () => {
    abort.abort();
    client.quit('shutting down');
    process.exit(0);
  });

  // Stream webhook responses back to IRC
  while (!abort.signal.aborted) {
    try {
      await streamToIrc(cfg, abort.signal, sendPrivmsg);
    } catch (err) {
      if (abort.signal.aborted) return;
      console.error('[irc] stream error:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
