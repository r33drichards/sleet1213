import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Client, Connection } from '@temporalio/client';
import { chatSession } from './workflows.js';
import { userMessageSignal } from './signals.js';

export type SignalWithStartFn = (
  workflow: typeof chatSession,
  options: {
    workflowId: string;
    taskQueue: string;
    args: [string, ...unknown[]];
    signal: typeof userMessageSignal;
    signalArgs: [string];
  },
) => Promise<{ workflowId: string }>;

export type AppDeps = {
  signalWithStart: SignalWithStartFn;
  taskQueue: string;
};

export function makeApp(deps: AppDeps) {
  const app = new Hono();

  app.post('/message', async (c) => {
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

    const handle = await deps.signalWithStart(chatSession, {
      workflowId: `chat:${body.sessionId}`,
      taskQueue: deps.taskQueue,
      args: [body.sessionId],
      signal: userMessageSignal,
      signalArgs: [body.msg],
    });

    return c.json({ ok: true, workflowId: handle.workflowId });
  });

  return app;
}

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = process.env.TASK_QUEUE ?? 'chat';
  const port = Number(process.env.WEBHOOK_PORT ?? 8787);

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const app = makeApp({
    // `as any` here bridges Hono-world typing to the Temporal client's
    // generic signalWithStart — the test uses a narrower mock signature.
    signalWithStart: (wf, opts) => client.workflow.signalWithStart(wf, opts as any) as any,
    taskQueue,
  });

  console.log(`Webhook listening on :${port}`);
  serve({ fetch: app.fetch, port });
}

// Only run if invoked as entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
