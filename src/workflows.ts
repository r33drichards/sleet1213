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
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '60 seconds',
  retry: { maximumAttempts: 3 },
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

    const result = await streamClaude({
      sessionId,
      history,
      userId,
      sdkSessionId: sdkSessionId || undefined,
    });

    sdkSessionId = result.sdkSessionId;
    history.push({ role: 'assistant', content: result.text });
    await persistTurn({ sessionId, role: 'assistant', content: result.text, userId });

    if (!titleGenerated && userTurn !== null) {
      titleGenerated = true;
      await generateTitle({ sessionId, userMessage: userTurn, userId });
    }

    if (workflowInfo().historyLength > HISTORY_LENGTH_LIMIT) {
      await continueAsNew<typeof chatSession>(sessionId, history, userId, sdkSessionId);
    }
  }
}
