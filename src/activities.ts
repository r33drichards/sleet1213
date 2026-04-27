import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { heartbeat, Context } from '@temporalio/activity';
import { publishDelta, publishThinking, publishToolCall, publishMessageStop, publishFinalText, publishTurnEnd } from './publish.js';
import { getRedis, getSubscriberClient, cancelChannel } from './redis.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  loadMemoryContext,
  listEnabledMcpServers,
} from './db.js';
import { createTedMcpServer } from './memory-mcp.js';
import type { Role, StreamReq } from './types.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';

/**
 * Stream an assistant turn using the Claude Agent SDK.
 *
 * Uses SDK session `resume` for multi-turn context — each turn resumes
 * the previous session so the agent has full conversation history without
 * us passing it manually.
 *
 * Returns { text, sdkSessionId, interrupted } so the workflow can track
 * the session and know whether the turn was cut short by a new user
 * message (allowing it to mark partial output appropriately).
 */
export async function streamClaude(req: StreamReq): Promise<{ text: string; sdkSessionId: string; interrupted: boolean }> {
  const memoryCtx = await loadMemoryContext(req.userId);
  const tedServer = createTedMcpServer(req.userId);

  // Build MCP servers from user's DB config
  const dbServers = await listEnabledMcpServers(req.userId);
  const userMcpServers: Record<string, any> = {};
  for (const s of dbServers) {
    if (s.transport === 'stdio' && s.command) {
      userMcpServers[s.name] = { command: s.command, args: s.args ?? [] };
    } else if (s.url) {
      userMcpServers[s.name] = { type: 'http', url: s.url };
    }
  }

  // Two-plugin overlay so the agent has both:
  //   * REPO_PLUGIN_DIR — read-only skills checked into github (sleet1213
  //     core skills like minecraft-bot, sleet1213-self-admin). Edits go
  //     through "edit on your laptop / push / git pull on the box".
  //   * LOCAL_PLUGIN_DIR — writable on-host scratch dir. New skills the
  //     agent invents at runtime live here. Survives restarts.
  const REPO_PLUGIN_DIR =
    process.env.SLEET1213_REPO_PLUGIN_DIR ??
    process.env.SLEET1213_PLUGIN_DIR ??
    '/app/ted-plugin';
  const LOCAL_PLUGIN_DIR =
    process.env.SLEET1213_LOCAL_PLUGIN_DIR ??
    '/home/ubuntu/.local/share/sleet1213/plugin';
  const REPO_SKILLS_DIR = `${REPO_PLUGIN_DIR}/skills`;
  const LOCAL_SKILLS_DIR = `${LOCAL_PLUGIN_DIR}/skills`;

  const systemParts: string[] = [
    `You have two skill directories overlaid:\n` +
      `  - REPO (read-only): ${REPO_SKILLS_DIR}/ — core skills checked into github.com/r33drichards/sleet1213. To edit these, edit the repo on a workstation, push to master, and run \`git pull\` + \`systemctl --user restart sleet1213-worker\` on this host.\n` +
      `  - LOCAL (writable): ${LOCAL_SKILLS_DIR}/ — your scratch dir. New skills you invent at runtime go here. Use the Write tool to create \`${LOCAL_SKILLS_DIR}/<name>/SKILL.md\` with YAML front matter (name + description), then a markdown body. Skills are reread per turn — no restart needed for skill changes.\n` +
      `Pick LOCAL by default for any new skill. Use REPO only for core capabilities you'd want every future deployment to inherit, and even then go via the github repo, not direct edits.`,
    `You can also add and remove MCP tool servers using mcp__ted__mcp_add, mcp__ted__mcp_list, mcp__ted__mcp_remove. New servers become available on the next turn.`,
  ];
  if (memoryCtx) systemParts.push(memoryCtx);

  const lastUserMsg = req.history.filter((m) => m.role === 'user').pop();
  const prompt = lastUserMsg?.content ?? '';

  // Workflow-driven interrupt path: the workflow calls requestStreamCancel
  // when a new user message arrives mid-turn, which publishes to a Redis
  // channel this activity subscribes to. We use Redis (rather than Temporal
  // CancellationScope) because Temporal's state machine errors out if a
  // cancel command lands on an activity still in SCHEDULED state.
  // Temporal-level cancellation (e.g. workflow close) is also wired so a
  // shutting-down workflow still aborts cleanly.
  const abort = new AbortController();
  Context.current().cancellationSignal.addEventListener('abort', () => abort.abort());

  const cancelSub = getSubscriberClient();
  await cancelSub.subscribe(cancelChannel(req.sessionId));
  cancelSub.on('message', (_chan, _msg) => {
    abort.abort();
  });

  const options: Options = {
    model: MODEL,
    abortController: abort,
    cwd: process.env.CLAUDE_CWD ?? '/home/ubuntu/sleet1213',
    additionalDirectories: [REPO_SKILLS_DIR, LOCAL_SKILLS_DIR],
    ...(process.env.CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
    systemPrompt: systemParts.join('\n\n'),
    plugins: [
      { type: 'local', path: REPO_PLUGIN_DIR },
      { type: 'local', path: LOCAL_PLUGIN_DIR },
    ],
    allowedTools: [
      'Read', 'Write', 'Edit',
      'Glob', 'Grep',
      'Bash',
      'WebSearch', 'WebFetch',
      'Skill', 'Agent',
      'TodoWrite',
      'NotebookEdit',
      'mcp__*',
    ],
    disallowedTools: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
    includePartialMessages: true,
    mcpServers: {
      ted: tedServer,
      ...userMcpServers,
    },
    // Resume previous SDK session for multi-turn context
    ...(req.sdkSessionId ? { resume: req.sdkSessionId } : {}),
  };

  let lastAssistantText = '';
  let sdkSessionId = req.sdkSessionId ?? '';
  let interrupted = false;

  // If resume fails (stale session), retry without resume
  async function* runQuery() {
    try {
      yield* query({ prompt, options });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No conversation found') && options.resume) {
        console.log(`[agent] stale session ${options.resume}, starting fresh`);
        delete options.resume;
        sdkSessionId = '';
        yield* query({ prompt, options });
      } else {
        throw err;
      }
    }
  }

  // Wall-clock heartbeat tick. The for-await below blocks for the whole
  // duration of any tool call the SDK is running (e.g. a baritone goto
  // that takes 90s to cross a bridge), so without a periodic tick the
  // activity wouldn't heartbeat for that whole window, Temporal would
  // declare it dead at heartbeatTimeout=60s, and retry the activity —
  // which re-passes the same user prompt with the same sdkSessionId, so
  // the agent ends up seeing the user's message twice via session resume
  // and concludes "the user is repeating the request".
  const hbTick = setInterval(() => {
    try { heartbeat(); } catch { /* activity may be already gone */ }
  }, 20_000);

  try {
    for await (const message of runQuery()) {
      heartbeat();

      // Capture session ID from init message
      if (message.type === 'system' && (message as any).subtype === 'init') {
        sdkSessionId = (message as any).session_id ?? sdkSessionId;
      }

      // Streaming events (token by token)
      if (message.type === 'stream_event' && (message as any).event) {
        const ev = (message as any).event;
        if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            await publishDelta(req.sessionId, ev.delta.text);
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            await publishThinking(req.sessionId, ev.delta.thinking);
          }
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          await publishToolCall(req.sessionId, ev.content_block.name ?? 'unknown');
        } else if (ev.type === 'message_stop') {
          // One LLM iteration finished (Bedrock message_stop). The bridge
          // flushes its accumulated text buffer here so each iteration
          // shows up as its own chat reply instead of getting concatenated
          // with later iterations into one mega-message at turn_end.
          await publishMessageStop(req.sessionId);
        }
      }

      // Complete assistant messages
      if (message.type === 'assistant') {
        const msg = (message as any).message;
        if (msg?.content) {
          const textParts = (msg.content as any[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '');
          if (textParts.length > 0) {
            lastAssistantText = textParts.join('');
          }
        }
      }

      // Result — agent finished this turn
      if (message.type === 'result') {
        const result = (message as any).result;
        if (typeof result === 'string' && result) {
          lastAssistantText = result;
        }
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      // Workflow cancelled this turn because a new user message arrived.
      // Swallow the abort and return whatever we'd already streamed so the
      // workflow can mark it as interrupted and resume the SDK session
      // with the new prompt.
      interrupted = true;
    } else {
      throw err;
    }
  } finally {
    clearInterval(hbTick);
    try { await cancelSub.quit(); } catch {}
    if (abort.signal.aborted) interrupted = true;
    // Always publish *something* to chat so the user sees the turn ended.
    // Without this, an interrupted-before-any-text turn produces a DB-side
    // [interrupted by user] marker that never reaches the IRC bridge,
    // leaving chat silent after `[using Tool]` lines.
    const chatText =
      lastAssistantText || (interrupted ? '[interrupted by user]' : '');
    if (chatText) {
      await publishFinalText(req.sessionId, chatText);
    }
    await publishTurnEnd(req.sessionId);
  }

  return { text: lastAssistantText, sdkSessionId, interrupted };
}

/**
 * Publishes a cancel signal to the running streamClaude activity for the
 * given session. The activity subscribes to this channel and aborts its
 * SDK query on receipt. Fire-and-forget from the workflow's POV — completes
 * as soon as Redis acks the publish.
 */
export async function requestStreamCancel(req: { sessionId: string }): Promise<void> {
  await getRedis().publish(cancelChannel(req.sessionId), '1');
}

export type PersistTurnReq = {
  sessionId: string;
  role: Role;
  content: string;
  userId: string;
};

export async function persistTurn(req: PersistTurnReq): Promise<void> {
  await appendMessage(req.sessionId, req.role, req.content, req.userId);
  await touchSession(req.sessionId);
}

const TITLE_MODEL = process.env.ANTHROPIC_TITLE_MODEL ?? 'claude-haiku-4-5';

export type GenerateTitleReq = {
  sessionId: string;
  userMessage: string;
  userId: string;
};

export async function generateTitle(req: GenerateTitleReq): Promise<void> {
  try {
    let title = '';
    for await (const message of query({
      prompt:
        'Summarise the following message as a concise 3-6 word chat ' +
        'title. Reply with ONLY the title text, no quotes, no ' +
        "punctuation, no leading 'Title:'.\n\n" +
        req.userMessage,
      options: {
        model: TITLE_MODEL,
        tools: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        ...(process.env.CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
      },
    })) {
      if (message.type === 'result') {
        const result = (message as any).result;
        if (typeof result === 'string') title = result;
      }
    }
    title = title
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\.+$/, '')
      .slice(0, 80)
      .trim();
    if (!title) return;
    await renameSession(req.sessionId, req.userId, title);
  } catch {
    // Best-effort
  }
}
