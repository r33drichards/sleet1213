import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import { userMessageSignal, closeSignal, transcriptQuery } from './signals.js';
import { drainInbox } from './inbox.js';
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

// requestStreamCancel intentionally not proxied here — automatic cancel
// is disabled in steer mode. The activity remains subscribed to the
// Redis cancel channel, so an out-of-band publisher (e.g. a future
// "stop" keyword handler or admin RPC) can still trigger an interrupt.

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

    const userTurn = drainInbox(inbox, history);
    if (userTurn !== null) {
      await persistTurn({ sessionId, role: 'user', content: userTurn, userId });
    }

    // "Steer" queue mode (per openclaw's queue-policy.ts:17): new user
    // messages that arrive while this turn is running do NOT cancel the
    // active run — they accumulate in `inbox` via userMessageSignal and
    // get drained as the next user turn after this one finishes, with
    // SDK session resume carrying context across. This avoids the rapid-
    // fire-commands-cancel-each-other footgun. Explicit interrupt is
    // still possible by publishing to the Redis cancel channel directly
    // (the activity subscribes), so a future "stop"/"cancel" keyword
    // path or admin RPC can wire one up without further changes here.
    const result = await streamClaude({
      sessionId,
      history,
      userId,
      sdkSessionId: sdkSessionId || undefined,
    });

    sdkSessionId = result.sdkSessionId;
    let assistantText = result.text;
    if (result.interrupted) {
      assistantText = (assistantText
        ? assistantText.replace(/\s+$/, '') + ' '
        : '') + '[interrupted by user]';
    }
    history.push({ role: 'assistant', content: assistantText });
    await persistTurn({ sessionId, role: 'assistant', content: assistantText, userId });

    if (!titleGenerated && userTurn !== null) {
      titleGenerated = true;
      await generateTitle({ sessionId, userMessage: userTurn, userId });
    }

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(sessionId, history, userId, sdkSessionId);
    }
  }
}
