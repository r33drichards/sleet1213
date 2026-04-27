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
  // 5 min cap is generous; the interrupt path covers genuinely long runs
  // by letting the user redirect mid-turn.
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '60 seconds',
  retry: { maximumAttempts: 3 },
});

const { requestStreamCancel } = proxyActivities<typeof activities>({
  // Tiny Redis publish — fail fast, no retries; if cancel doesn't reach the
  // streamer the worst case is the turn finishes naturally.
  startToCloseTimeout: '5 seconds',
  retry: { maximumAttempts: 1 },
});

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

    // Run the activity, with a parallel watcher that fires a Redis-backed
    // cancel when a new user message lands mid-turn. The activity then
    // aborts its SDK query and returns whatever partial text it had. We
    // don't use Temporal CancellationScope here because cancelling an
    // activity in SCHEDULED state crashes Temporal's workflow state
    // machine.
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

    const watcherPromise = (async () => {
      await condition(() => inbox.length > 0 || activityDone);
      if (activityDone) return;
      // New message arrived first — tell the streamer to abort. Fire and
      // forget; if the publish fails the turn just finishes naturally.
      await requestStreamCancel({ sessionId });
    })();

    const result = await activityPromise;
    await watcherPromise; // resolve cleanly so no orphan promise

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
