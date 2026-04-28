/**
 * schedule-activities.ts
 *
 * Lightweight activities used by the scheduledPrompt workflow.
 * Kept in a separate file so the main activities module doesn't grow.
 */

export interface FireScheduledPromptReq {
  sessionId: string;
  userId: string;
  prompt: string;
}

/**
 * Posts a message to the local webhook /message endpoint — the same path
 * the IRC bridge uses. This lets a Temporal Schedule inject a prompt into
 * an existing chatSession without duplicating any auth/session logic.
 *
 * Before firing, it echoes the prompt to the IRC channel so viewers can
 * see what triggered the bot (scheduled prompts don't originate from chat
 * so the IRC bridge wouldn't normally display them).
 */
export async function fireScheduledPrompt(req: FireScheduledPromptReq): Promise<void> {
  // Echo the scheduled prompt to IRC so it's visible in Twitch chat.
  // The IRC bridge runs a tiny HTTP echo server on IRC_ECHO_PORT (default 8790).
  const echoPort = process.env.IRC_ECHO_PORT ?? '8790';
  try {
    await fetch(`http://127.0.0.1:${echoPort}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `[scheduled] ${req.prompt}` }),
    });
  } catch { /* best-effort — IRC bridge may be down */ }

  const webhookUrl = process.env.WEBHOOK_URL ?? 'http://127.0.0.1:8787';

  // Prepend the scheduled prompt as a visible "user" message so the
  // session transcript (and Twitch chat via the IRC bridge's SSE
  // listener) shows the trigger. The message format mimics what a human
  // would type: "scheduler: <prompt>".
  const visibleMsg = `scheduler: ${req.prompt}`;

  const resp = await fetch(`${webhookUrl}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-ID': req.userId,
    },
    body: JSON.stringify({
      sessionId: req.sessionId,
      msg: visibleMsg,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`webhook /message returned ${resp.status}: ${text}`);
  }
}
