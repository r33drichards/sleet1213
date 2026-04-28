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
): Promise<void> {
  type InboxItem = { msg: string; agentConfig?: AgentConfig; userId?: string };
  const inbox: InboxItem[] = [];
  const history: Msg[] = [...seedHistory];
  let closed = false;
  let titleGenerated = seedHistory.length > 0;
  // Single SDK session shared by every turn in this Twitch session.
  // Per-Query tool overrides come from the inbox item's agentConfig.
  let sdkSessionId = seedSdkSessionId;

  setHandler(userMessageSignal, (msg: string, agentConfig?: AgentConfig, signalUserId?: string) => {
    inbox.push({ msg, agentConfig, userId: signalUserId });
  });
  setHandler(closeSignal, () => {
    closed = true;
  });
  setHandler(transcriptQuery, () => history);

  while (!closed) {
    await condition(() => inbox.length > 0 || closed);
    if (closed) break;

    const firstItem = inbox.shift()!;
    const cfgKey = agentConfigKey(firstItem.agentConfig);
    const turnUserId = firstItem.userId || userId;

    history.push({ role: 'user', content: firstItem.msg });
    await persistTurn({
      sessionId,
      role: 'user',
      content: firstItem.msg,
      userId: turnUserId,
    });

    let activityDone = false;
    const activityPromise = (async () => {
      try {
        return await streamClaude({
          sessionId,
          history,
          userId: turnUserId,
          sdkSessionId: sdkSessionId || undefined,
          agentConfig: firstItem.agentConfig,
        });
      } finally {
        activityDone = true;
      }
    })();

    // Forwarder: only interleave SAME-cfgKey messages into the running
    // Query. Different-cfgKey messages would land in a Query with the
    // wrong tool set (a public msg interleaved into an admin turn would
    // get admin tools), so they wait for the next loop iteration.
    const forwarderPromise = (async () => {
      while (!activityDone) {
        await condition(
          () =>
            inbox.some((i) => agentConfigKey(i.agentConfig) === cfgKey) ||
            activityDone,
        );
        if (activityDone) return;
        let idx = 0;
        while (idx < inbox.length && !activityDone) {
          if (agentConfigKey(inbox[idx].agentConfig) !== cfgKey) {
            idx++;
            continue;
          }
          const item = inbox.splice(idx, 1)[0];
          history.push({ role: 'user', content: item.msg });
          await persistTurn({
            sessionId,
            role: 'user',
            content: item.msg,
            userId: turnUserId,
          });
          await pushUserMessageToStream({ sessionId, msg: item.msg });
        }
      }
    })();

    const result = await activityPromise;
    await forwarderPromise;

    if (result.sdkSessionId) {
      sdkSessionId = result.sdkSessionId;
    }
    if (result.text) {
      history.push({ role: 'assistant', content: result.text });
    } else if (result.interrupted) {
      history.push({ role: 'assistant', content: '[interrupted by user]' });
    }

    if (!titleGenerated) {
      titleGenerated = true;
      await generateTitle({
        sessionId,
        userMessage: firstItem.msg,
        userId: turnUserId,
      });
    }

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(
        sessionId,
        history,
        userId,
        sdkSessionId,
      );
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
