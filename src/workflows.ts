import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import { userMessageSignal, closeSignal, transcriptQuery } from './signals.js';
import type { Msg } from './types.js';

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

export async function chatSession(
  sessionId: string,
  seedHistory: Msg[] = [],
  userId: string = '',
  seedSdkSessionId: string = '',
): Promise<void> {
  const inbox: string[] = [];
  const history: Msg[] = [...seedHistory];
  let closed = false;
  let titleGenerated = seedHistory.length > 0;
  // Track the SDK session ID for multi-turn context via resume
  let sdkSessionId = seedSdkSessionId;

  setHandler(userMessageSignal, (msg: string) => {
    inbox.push(msg);
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
    const firstMsg = inbox.shift()!;
    history.push({ role: 'user', content: firstMsg });
    await persistTurn({ sessionId, role: 'user', content: firstMsg, userId });

    let activityDone = false;
    const activityPromise = (async () => {
      try {
        return await streamClaude({
          sessionId,
          history,
          userId,
          sdkSessionId: sdkSessionId || undefined,
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
          const m = inbox.shift()!;
          history.push({ role: 'user', content: m });
          await persistTurn({ sessionId, role: 'user', content: m, userId });
          await pushUserMessageToStream({ sessionId, msg: m });
        }
      }
    })();

    const result = await activityPromise;
    await forwarderPromise;

    sdkSessionId = result.sdkSessionId;
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
    const userTurn = firstMsg;

    if (!titleGenerated && userTurn !== null) {
      titleGenerated = true;
      await generateTitle({ sessionId, userMessage: userTurn, userId });
    }

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(sessionId, history, userId, sdkSessionId);
    }
  }
}
