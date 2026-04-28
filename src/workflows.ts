import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type * as scheduleActivities from './schedule-activities.js';
import { userMessageSignal, closeSignal, transcriptQuery } from './signals.js';
import type { AgentConfig, Msg } from './types.js';

const { streamClaude, persistTurn, generateTitle } = proxyActivities<
  typeof activities
>({
  // Multi-step Minecraft tasks (e.g. crossing the basalt bridge under
  // baritone) routinely take 5-15 min. The interrupt path covers user-
  // initiated stops; this cap is just the runaway-protection ceiling.
  // The activity heartbeats every 20s on a wall-clock tick (see
  // streamClaude) so a 3 min heartbeat budget is plenty of headroom.
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '3 minutes',
  // Only retry on truly transient failures. We do NOT want a retry on
  // heartbeat-timeout — that would hand the agent the same prompt twice
  // via SDK session resume and the agent concludes "the user is
  // repeating their request".
  retry: { maximumAttempts: 1 },
});

// pushUserMessageToStream: tiny Redis publish, fail fast.
const { pushUserMessageToStream } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 seconds',
  retry: { maximumAttempts: 1 },
});

// requestStreamCancel intentionally not proxied here — automatic cancel
// is disabled. The activity remains subscribed to the Redis cancel
// channel, so an out-of-band publisher (e.g. a "stop" keyword handler
// or admin RPC) can still trigger an interrupt.

const HISTORY_LENGTH_LIMIT = 2000;

/**
 * Compute a stable fingerprint for an AgentConfig so we can maintain
 * separate SDK sessions per tool-set. Different tool configs MUST NOT
 * share an SDK session because `resume` carries forward the original
 * tool restrictions.
 */
function agentConfigKey(cfg?: AgentConfig): string {
  if (!cfg) return 'default';
  // Sort tools for stability, include plugins flag and disallowed
  const tools = [...(cfg.allowedTools ?? [])].sort().join(',');
  const blocked = [...(cfg.disallowedTools ?? [])].sort().join(',');
  return `${tools}|blocked=${blocked}|plugins=${cfg.includePlugins ?? false}`;
}

export async function chatSession(
  sessionId: string,
  seedHistory: Msg[] = [],
  userId: string = '',
  seedSdkSessionId: string = '',
  _legacyAgentConfig?: AgentConfig,
  seedSdkSessionMap: Record<string, string> = {},
): Promise<void> {
  type InboxItem = { msg: string; agentConfig?: AgentConfig };
  const inbox: InboxItem[] = [];
  const history: Msg[] = [...seedHistory];
  let closed = false;
  let titleGenerated = seedHistory.length > 0;
  // Track SDK session IDs per agent config fingerprint. Different tool
  // sets need separate SDK sessions because `resume` carries forward the
  // original tool restrictions. Seed from continueAsNew or legacy single ID.
  const sdkSessionMap: Record<string, string> = { ...seedSdkSessionMap };
  if (seedSdkSessionId && !sdkSessionMap['default']) {
    sdkSessionMap['default'] = seedSdkSessionId;
  }

  setHandler(userMessageSignal, (msg: string, agentConfig?: AgentConfig) => {
    inbox.push({ msg, agentConfig });
  });
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(transcriptQuery, () => history);

  while (!closed) {
    await condition(() => inbox.length > 0 || closed);
    if (closed) break;

    // Drain the FIRST queued message; the activity will be started with
    // it as the initial prompt. Any subsequent messages that arrive
    // during the activity are forwarded via Redis to streamInput so the
    // agent sees them mid-turn (true interleaving — not interrupt, not
    // queue-after-completion).
    const firstItem = inbox.shift()!;
    history.push({ role: 'user', content: firstItem.msg });
    await persistTurn({ sessionId, role: 'user', content: firstItem.msg, userId });

    // Look up the SDK session for this agent config's tool fingerprint.
    // Different tool sets get separate SDK sessions so `tools` restrictions
    // are enforced fresh instead of being inherited from a prior resume.
    const cfgKey = agentConfigKey(firstItem.agentConfig);
    const sdkSessionId = sdkSessionMap[cfgKey] ?? '';

    let activityDone = false;
    const activityPromise = (async () => {
      try {
        return await streamClaude({
          sessionId,
          history,
          userId,
          sdkSessionId: sdkSessionId || undefined,
          agentConfig: firstItem.agentConfig,
        });
      } finally {
        activityDone = true;
      }
    })();

    // Forwarder: while the activity runs, push each new inbox message
    // into the running SDK query via Redis.
    const forwarderPromise = (async () => {
      while (!activityDone) {
        await condition(() => inbox.length > 0 || activityDone);
        if (activityDone) return;
        while (inbox.length > 0 && !activityDone) {
          const item = inbox.shift()!;
          history.push({ role: 'user', content: item.msg });
          await persistTurn({ sessionId, role: 'user', content: item.msg, userId });
          await pushUserMessageToStream({ sessionId, msg: item.msg });
        }
      }
    })();

    const result = await activityPromise;
    await forwarderPromise;

    // Store the returned SDK session ID under this config's key.
    if (result.sdkSessionId) {
      sdkSessionMap[cfgKey] = result.sdkSessionId;
    }
    // The activity persists each per-result assistant message itself
    // (because in interleave mode there can be multiple per turn). We
    // only mirror the joined text into in-memory `history` so the
    // workflow's transcriptQuery and continueAsNew snapshot stay in
    // sync with the DB.
    if (result.text) {
      history.push({ role: 'assistant', content: result.text });
    } else if (result.interrupted) {
      history.push({ role: 'assistant', content: '[interrupted by user]' });
    }
    const userTurn = firstItem.msg;

    if (!titleGenerated && userTurn !== null) {
      titleGenerated = true;
      await generateTitle({ sessionId, userMessage: userTurn, userId });
    }

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(sessionId, history, userId, '', undefined, sdkSessionMap);
    }
  }
}

// ---------------------------------------------------------------------------
// scheduledPrompt — a short-lived workflow started by Temporal Schedules.
// It fires a prompt into an existing chatSession by HTTP-POSTing to the
// local webhook, exactly like the IRC bridge does. The chatSession handles
// the rest (signal-with-start, streaming, etc.).
// ---------------------------------------------------------------------------
const { fireScheduledPrompt } = proxyActivities<typeof scheduleActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2 },
});

export async function scheduledPrompt(
  sessionId: string,
  userId: string,
  prompt: string,
): Promise<void> {
  const taggedPrompt = `[SCHEDULED] ${prompt}`;
  await fireScheduledPrompt({ sessionId, userId, prompt: taggedPrompt });
}
