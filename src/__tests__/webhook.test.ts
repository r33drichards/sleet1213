import { describe, it, expect, vi } from 'vitest';
import { makeApp } from '../webhook.js';

describe('webhook /message', () => {
  it('rejects missing fields with 400', async () => {
    const signalWithStart = vi.fn();
    const app = makeApp({
      signalWithStart,
      taskQueue: 'chat',
    });

    const res = await app.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'abc' }), // missing msg
    });

    expect(res.status).toBe(400);
    expect(signalWithStart).not.toHaveBeenCalled();
  });

  it('calls signalWithStart with the right arguments', async () => {
    const signalWithStart = vi.fn().mockResolvedValue({ workflowId: 'chat:abc' });
    const app = makeApp({
      signalWithStart,
      taskQueue: 'chat',
    });

    const res = await app.request('/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'abc', msg: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(signalWithStart).toHaveBeenCalledTimes(1);
    const call = signalWithStart.mock.calls[0];
    expect(call[1]).toMatchObject({
      workflowId: 'chat:abc',
      taskQueue: 'chat',
      args: ['abc'],
      signalArgs: ['hello'],
    });
  });
});
