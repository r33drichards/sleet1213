import type { Msg } from './types.js';

/**
 * Drains `inbox` into `history` as a single user turn.
 * Mutates both arrays. Does nothing if inbox is empty.
 *
 * Coalesces multiple queued messages into one joined turn because Claude's
 * API requires alternating user/assistant roles.
 */
export function drainInbox(inbox: string[], history: Msg[]): void {
  if (inbox.length === 0) return;
  const combined = inbox.splice(0).join('\n\n');
  history.push({ role: 'user', content: combined });
}
