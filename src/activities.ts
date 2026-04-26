import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { heartbeat } from '@temporalio/activity';
import { publishDelta, publishThinking, publishToolCall, publishMessageStop, publishTurnEnd } from './publish.js';
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
 * Returns { text, sdkSessionId } so the workflow can track the session.
 */
export async function streamClaude(req: StreamReq): Promise<{ text: string; sdkSessionId: string }> {
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

  const options: Options = {
    model: MODEL,
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
  } finally {
    await publishTurnEnd(req.sessionId);
  }

  return { text: lastAssistantText, sdkSessionId };
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
