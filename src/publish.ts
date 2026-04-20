/**
 * Fan-out sink for streaming deltas. Stubbed — swap for Redis pub/sub,
 * NATS, SSE relay, or whatever the UI subscribes to.
 *
 * Key by sessionId so every session's subscriber gets only its own tokens.
 */
export async function publishDelta(sessionId: string, text: string): Promise<void> {
  // No-op stub. Replace with real transport.
  // For debugging: console.log(`[${sessionId}] ${text}`);
}
