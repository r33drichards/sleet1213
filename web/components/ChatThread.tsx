'use client';
import { useChat } from '@ai-sdk/react';

type Msg = { role: 'user' | 'assistant'; content: string };

export default function ChatThread({
  sessionId,
  initialMessages,
}: {
  sessionId: string;
  initialMessages: Msg[];
}) {
  const { messages, input, handleInputChange, handleSubmit, status } = useChat({
    api: '/api/chat',
    id: sessionId,
    initialMessages: initialMessages.map((m, i) => ({
      id: `${i}`,
      role: m.role,
      content: m.content,
    })),
  });

  const busy = status === 'streaming' || status === 'submitted';

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.length === 0 ? (
            <p className="text-sm text-zinc-500">Start a conversation.</p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-xl px-4 py-3 text-sm ${
                  m.role === 'user'
                    ? 'self-end bg-emerald-700 text-white'
                    : 'self-start bg-zinc-800 text-zinc-100'
                }`}
              >
                <span className="whitespace-pre-wrap">{m.content}</span>
              </div>
            ))
          )}
          {busy && (
            <span className="self-start text-xs text-zinc-500">...</span>
          )}
        </div>
      </div>
      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-800 bg-zinc-900 p-4"
      >
        <div className="mx-auto flex max-w-3xl gap-2">
          <input
            value={input}
            onChange={handleInputChange}
            disabled={busy}
            placeholder="Message Ted"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-emerald-500"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
