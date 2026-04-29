import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { heartbeat, Context } from '@temporalio/activity';
import { publishDelta, publishThinking, publishToolCall, publishMessageStop, publishFinalText, publishTurnEnd } from './publish.js';
import { getRedis, getSubscriberClient, cancelChannel, inputChannel } from './redis.js';
import {
  appendMessage,
  touchSession,
  renameSession,
  loadMemoryContext,
  listEnabledMcpServers,
} from './db.js';
import { createTedMcpServer } from './memory-mcp.js';
import type { AgentConfig, Role, StreamReq } from './types.js';
import { DEFAULT_PUBLIC_CONFIG } from './nick-groups.js';

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5';
// Hard cap on a single streamClaude turn. Long baritone tool calls can
// run 5-15 min legitimately; anything past this is treated as a stall.
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 20 * 60 * 1000);

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
  // Resolve agent config — use per-group config if provided, else default to
  // public (least-privilege). Admin access requires an explicit agentConfig
  // from the IRC bridge's nick-group lookup. This is defense-in-depth:
  // any code path that forgets to pass agentConfig gets public restrictions
  // instead of accidentally granting admin.
  const agentCfg: AgentConfig = req.agentConfig ?? DEFAULT_PUBLIC_CONFIG;

  const memoryCtx = agentCfg.includeUserMcpServers
    ? await loadMemoryContext(req.userId)
    : '';
  // Only expose mcp_add/mcp_list/mcp_remove tools when the agent has
  // includeUserMcpServers (admin). Public agents get memory + schedule
  // tools only — no MCP server management.
  const tedServer = createTedMcpServer(req.userId, {
    includeMcpManagement: agentCfg.includeUserMcpServers,
  });

  // Build MCP servers from user's DB config (only if the group allows it)
  const userMcpServers: Record<string, any> = {};
  if (agentCfg.includeUserMcpServers) {
    const dbServers = await listEnabledMcpServers(req.userId);
    for (const s of dbServers) {
      if (s.transport === 'stdio' && s.command) {
        userMcpServers[s.name] = { command: s.command, args: s.args ?? [] };
      } else if (s.url) {
        userMcpServers[s.name] = { type: 'http', url: s.url };
      }
    }
  }

  // Build extra MCP servers from the group config
  const extraMcpServers: Record<string, any> = {};
  if (agentCfg.extraMcpServers) {
    for (const [name, srv] of Object.entries(agentCfg.extraMcpServers)) {
      if (srv.command) {
        extraMcpServers[name] = { command: srv.command, args: srv.args ?? [] };
      } else if (srv.url) {
        extraMcpServers[name] = { type: srv.type ?? 'http', url: srv.url };
      }
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

  const systemParts: string[] = [];
  if (agentCfg.includePlugins) {
    systemParts.push(
      `You have two skill directories overlaid:\n` +
        `  - REPO (read-only): ${REPO_SKILLS_DIR}/ — core skills checked into github.com/r33drichards/sleet1213. To edit these, edit the repo on a workstation, push to master, and run \`git pull\` + \`systemctl --user restart sleet1213-worker\` on this host.\n` +
        `  - LOCAL (writable): ${LOCAL_SKILLS_DIR}/ — your scratch dir. New skills you invent at runtime go here. Use the Write tool to create \`${LOCAL_SKILLS_DIR}/<name>/SKILL.md\` with YAML front matter (name + description), then a markdown body. Skills are reread per turn — no restart needed for skill changes.\n` +
        `Pick LOCAL by default for any new skill. Use REPO only for core capabilities you'd want every future deployment to inherit, and even then go via the github repo, not direct edits.`,
      `You can also add and remove MCP tool servers using mcp__ted__mcp_add, mcp__ted__mcp_list, mcp__ted__mcp_remove. New servers become available on the next turn.`,
    );
  }
  if (memoryCtx) systemParts.push(memoryCtx);
  if (agentCfg.systemPromptSuffix) systemParts.push(agentCfg.systemPromptSuffix);
  if (req.sdkSessionId) {
    systemParts.push(
      'Note: this conversation transcript may contain prior tool_use blocks ' +
      '(e.g. Bash, Edit, or mcp__* tools) that were available to a different ' +
      'participant and are NOT registered in this turn. Only invoke tools ' +
      'that appear in your current tool list; do not attempt to call any ' +
      'tool you see referenced in transcript history but not in your current tools.',
    );
  }

  const lastUserMsg = req.history.filter((m) => m.role === 'user').pop();
  const initialPrompt = lastUserMsg?.content ?? '';

  // Cancel path: any publish to sleet1213:cancel:<sessionId> aborts the
  // SDK. Currently no automatic publisher (steer-by-default), but kept
  // available for an out-of-band stop. Temporal context cancellation is
  // also bridged so a workflow close shuts the SDK down cleanly.
  const abort = new AbortController();
  Context.current().cancellationSignal.addEventListener('abort', () => abort.abort());

  // Turn-timeout watchdog. If the SDK hasn't returned within
  // TURN_TIMEOUT_MS, abort it so the workflow can move on to the next
  // queued message rather than holding the lane forever.
  let timedOut = false;
  const turnTimer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, TURN_TIMEOUT_MS);

  const cancelSub = getSubscriberClient();
  await cancelSub.subscribe(cancelChannel(req.sessionId));
  cancelSub.on('message', () => abort.abort());

  // Interleave path: subscribe to sleet1213:input:<sessionId>. Each
  // published string is pushed into the running SDK query as a new user
  // message via streamInput, so the agent sees it mid-turn and adapts
  // without restarting.
  const inputSub = getSubscriberClient();
  await inputSub.subscribe(inputChannel(req.sessionId));

  // Build options — tools, plugins, MCP servers vary by group config
  const mcpServers: Record<string, any> = {
    ted: tedServer,
    ...userMcpServers,
    ...extraMcpServers,
  };

  const plugins = agentCfg.includePlugins
    ? [
        { type: 'local' as const, path: REPO_PLUGIN_DIR },
        { type: 'local' as const, path: LOCAL_PLUGIN_DIR },
      ]
    : [];

  const additionalDirectories = agentCfg.includePlugins
    ? [REPO_SKILLS_DIR, LOCAL_SKILLS_DIR]
    : [];

  const options: Options = {
    model: agentCfg.model ?? MODEL,
    abortController: abort,
    cwd: process.env.CLAUDE_CWD ?? '/home/ubuntu/sleet1213',
    additionalDirectories,
    ...(process.env.CLAUDE_CODE_PATH ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH } : {}),
    systemPrompt: systemParts.join('\n\n'),
    plugins,
    tools: agentCfg.allowedTools,
    allowedTools: agentCfg.allowedTools,
    disallowedTools: agentCfg.disallowedTools ?? [],
    permissionMode: (agentCfg.permissionMode ?? 'bypassPermissions') as any,
    allowDangerouslySkipPermissions: true,
    settingSources: ['project', 'local'],
    includePartialMessages: true,
    mcpServers,
    // Resume previous SDK session for multi-turn context
    ...(req.sdkSessionId ? { resume: req.sdkSessionId } : {}),
  };

  let lastAssistantText = '';
  let sdkSessionId = req.sdkSessionId ?? '';
  let interrupted = false;
  const assistantTexts: string[] = [];

  // Pumped input generator. The first item is the initial prompt; further
  // items are fed by the Redis input subscription. The activity exits when
  // the agent has emitted a `result` for every queued user message AND no
  // new message has arrived within INTERLEAVE_GRACE_MS.
  type Pending =
    | { kind: 'msg'; text: string }
    | { kind: 'close' };
  const pendingQueue: Pending[] = [{ kind: 'msg', text: initialPrompt }];
  // Wrapper object so TS doesn't narrow the property away inside closures.
  const wakeRef: { fn: (() => void) | null } = { fn: null };
  const enqueue = (p: Pending) => {
    pendingQueue.push(p);
    const f = wakeRef.fn;
    wakeRef.fn = null;
    if (f) f();
  };

  let pendingResults = 1; // counts user messages whose `result` we haven't seen
  const INTERLEAVE_GRACE_MS = 1500;
  let graceTimer: NodeJS.Timeout | null = null;
  let inputClosed = false;

  inputSub.on('message', (_chan, msg) => {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    pendingResults++;
    enqueue({ kind: 'msg', text: msg });
    // (workflow already persisted this user turn before publishing)
  });

  async function* userInputStream(): AsyncIterable<any> {
    while (!inputClosed) {
      while (pendingQueue.length > 0) {
        const item = pendingQueue.shift()!;
        if (item.kind === 'close') { inputClosed = true; return; }
        yield {
          type: 'user',
          message: { role: 'user', content: item.text },
          parent_tool_use_id: null,
          session_id: sdkSessionId || undefined,
        };
      }
      if (inputClosed) return;
      await new Promise<void>((resolve) => { wakeRef.fn = resolve; });
    }
  }

  // Hold a live reference to the SDK Query so we can call q.close() when
  // the grace timer fires. Closing the input iterator alone doesn't end
  // the for-await loop — the Query keeps waiting for more streamInput
  // and the activity (and its Redis subscribers) leaks until Temporal
  // hits startToCloseTimeout.
  let q = query({ prompt: userInputStream(), options });
  const queryRef: { current: typeof q } = { current: q };
  // If resume fails ("No conversation found"), retry without resume.
  async function* runQuery() {
    try {
      yield* q;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No conversation found') && options.resume) {
        console.log(`[agent] stale session ${options.resume}, starting fresh`);
        delete options.resume;
        sdkSessionId = '';
        // Restart the input stream from scratch so the SDK gets the
        // initial prompt again on the fresh session.
        pendingQueue.unshift({ kind: 'msg', text: initialPrompt });
        q = query({ prompt: userInputStream(), options });
        queryRef.current = q;
        yield* q;
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

      // Result — agent finished one user-message-worth of work. Persist
      // and publish the assistant's reply, decrement the pending counter,
      // and start the grace timer if the queue is empty. New messages
      // arriving within the grace window keep the activity alive (and
      // cancel the timer).
      if (message.type === 'result') {
        const r = (message as any).result;
        if (typeof r === 'string' && r) lastAssistantText = r;
        if (lastAssistantText) {
          await publishFinalText(req.sessionId, lastAssistantText);
          await appendMessage(req.sessionId, 'assistant', lastAssistantText, req.userId).catch(() => {});
          assistantTexts.push(lastAssistantText);
          lastAssistantText = '';
        }
        pendingResults = Math.max(0, pendingResults - 1);
        if (pendingResults === 0 && pendingQueue.length === 0 && !abort.signal.aborted) {
          if (graceTimer) clearTimeout(graceTimer);
          graceTimer = setTimeout(() => {
            inputClosed = true;
            // Wake the input generator so it observes inputClosed.
            const f = wakeRef.fn; wakeRef.fn = null; if (f) f();
            // Close the SDK query — without this, the for-await stays
            // parked waiting for more streamInput forever.
            try { queryRef.current.close(); } catch { /* already closed */ }
          }, INTERLEAVE_GRACE_MS);
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
    clearTimeout(turnTimer);
    if (graceTimer) clearTimeout(graceTimer);
    inputClosed = true;
    const wake = wakeRef.fn;
    wakeRef.fn = null;
    if (wake) wake();
    // Make sure the SDK process shuts down even if we got here via a
    // throw, abort, or finally-without-grace.
    try { queryRef.current.close(); } catch {}
    try { await cancelSub.quit(); } catch {}
    try { await inputSub.quit(); } catch {}
    if (abort.signal.aborted) interrupted = true;
    // If the activity ends without any assistant reply having reached
    // chat (e.g. aborted before text materialised), surface the marker
    // so chat isn't silent after [using Tool] lines.
    if (assistantTexts.length === 0) {
      if (interrupted) {
        const marker = timedOut
          ? `[interrupted: turn exceeded ${Math.round(TURN_TIMEOUT_MS / 60000)} min — try again]`
          : '[interrupted by user]';
        await publishFinalText(req.sessionId, marker);
      } else if (lastAssistantText) {
        await publishFinalText(req.sessionId, lastAssistantText);
        assistantTexts.push(lastAssistantText);
      }
    } else if (lastAssistantText) {
      // Trailing text the SDK didn't wrap into a result event.
      await publishFinalText(req.sessionId, lastAssistantText);
      assistantTexts.push(lastAssistantText);
    }
    await publishTurnEnd(req.sessionId);
  }

  // The workflow stores `text` as the assistant turn's content. With
  // interleaving the activity may have produced several replies; join
  // them so workflow history reflects what was sent to chat.
  const combinedText = assistantTexts.join('\n\n');
  return { text: combinedText, sdkSessionId, interrupted };
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

/**
 * Forward a user message to the running streamClaude activity for the
 * given session. The activity subscribes to this channel and pushes the
 * message into its SDK query via streamInput, so the agent sees it
 * mid-turn and interleaves it with whatever it's currently doing.
 */
export async function pushUserMessageToStream(req: {
  sessionId: string;
  msg: string;
}): Promise<void> {
  await getRedis().publish(inputChannel(req.sessionId), req.msg);
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
