'use client';
import { useEffect, useRef, useState } from 'react';

type Row = { id: string; title: string | null; updated_at: string };

export default function ChatHeader({ sessionId }: { sessionId: string }) {
  const [title, setTitle] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function fetchTitle(): Promise<string | null> {
    const res = await fetch('/api/sessions', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { sessions: Row[] };
    return data.sessions.find((r) => r.id === sessionId)?.title ?? null;
  }

  // Initial load + poll while still empty — Haiku-generated title lands a
  // couple of seconds after the first assistant turn.
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    (async () => {
      const initial = await fetchTitle();
      if (cancelled) return;
      setTitle(initial);
      if (!initial) {
        interval = setInterval(async () => {
          const t = await fetchTitle();
          if (cancelled) return;
          if (t) {
            setTitle(t);
            if (interval) clearInterval(interval);
          }
        }, 2000);
      }
    })();
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [sessionId]);

  useEffect(() => {
    if (editing) {
      setDraft(title ?? '');
      // next paint
      queueMicrotask(() => inputRef.current?.select());
    }
  }, [editing, title]);

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === title) {
      setEditing(false);
      return;
    }
    const prev = title;
    setTitle(trimmed); // optimistic
    setEditing(false);
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: trimmed }),
    });
    if (!res.ok) setTitle(prev); // roll back
  }

  return (
    <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-6 py-3">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          onBlur={commit}
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-emerald-500"
          aria-label="Chat title"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex items-baseline gap-2 rounded px-2 py-1 text-left text-sm font-medium text-zinc-100 hover:bg-zinc-800"
          title="Click to rename"
        >
          <span className="truncate max-w-[50ch]">
            {title ?? <span className="text-zinc-500 italic">Untitled chat</span>}
          </span>
          {!title && (
            <span className="text-[10px] uppercase tracking-wide text-zinc-600">
              generating…
            </span>
          )}
        </button>
      )}
    </header>
  );
}
