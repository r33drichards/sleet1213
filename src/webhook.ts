import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { Client, Connection } from '@temporalio/client';
import { chatSession } from './workflows.js';
import { userMessageSignal } from './signals.js';
import {
  ensureSchema,
  getMessages,
  createSession,
  sessionBelongsTo,
} from './db.js';
import { subscribeDeltas } from './publish.js';

type Vars = { userId: string };

export function makeApp(deps: {
  signalWithStart: (wf: typeof chatSession, opts: any) => Promise<any>;
  taskQueue: string;
}) {
  const app = new Hono<{ Variables: Vars }>();

  app.use('*', async (c, next) => {
    const userId = c.req.header('X-User-ID');
    if (!userId) {
      return c.json({ error: 'X-User-ID required' }, 401);
    }
    c.set('userId', userId);
    await next();
  });

  app.post('/message', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body.sessionId !== 'string' ||
      typeof body.msg !== 'string' ||
      !body.sessionId ||
      !body.msg
    ) {
      return c.json({ error: 'sessionId and msg required' }, 400);
    }

    const exists = await sessionBelongsTo(body.sessionId, userId);
    if (!exists) {
      await createSession(userId, body.sessionId);
      const nowOwned = await sessionBelongsTo(body.sessionId, userId);
      if (!nowOwned) {
        return c.json({ error: 'session belongs to another user' }, 403);
      }
    }

    // agentConfig is optional — the IRC bridge passes it when nick groups
    // are configured. The workflow threads it through to the activity so
    // different groups get different agent capabilities.
    const agentConfig = body.agentConfig ?? undefined;

    await deps.signalWithStart(chatSession, {
      workflowId: `chat:${body.sessionId}`,
      taskQueue: deps.taskQueue,
      args: [body.sessionId, [], userId, '', agentConfig],
      signal: userMessageSignal,
      signalArgs: [body.msg],
    });

    return c.json({ ok: true });
  });

  app.get('/sessions/:sessionId/messages', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await sessionBelongsTo(sessionId, userId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const messages = await getMessages(sessionId, userId);
    return c.json({ sessionId, messages });
  });

  app.get('/sessions/:sessionId/stream', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('sessionId');
    if (!(await sessionBelongsTo(sessionId, userId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const lastEventId = c.req.header('Last-Event-ID');
    const fromQuery = c.req.query('from');
    const from = lastEventId ?? fromQuery ?? '$';

    return streamSSE(c, async (sse) => {
      const abort = new AbortController();
      const onClose = () => abort.abort();
      c.req.raw.signal?.addEventListener('abort', onClose);

      try {
        for await (const { id, event } of subscribeDeltas(sessionId, from, abort.signal)) {
          await sse.writeSSE({ id, data: JSON.stringify(event) });
        }
      } finally {
        c.req.raw.signal?.removeEventListener('abort', onClose);
        abort.abort();
      }
    });
  });

  return app;
}

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = process.env.TASK_QUEUE ?? 'chat';
  const port = Number(process.env.WEBHOOK_PORT ?? 8787);

  await ensureSchema();

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const app = makeApp({
    signalWithStart: (wf, opts) => client.workflow.signalWithStart(wf, opts) as any,
    taskQueue,
  });

  console.log(`Webhook listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
