'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Row = { id: string; title: string | null; updated_at: string };

export default function Sidebar() {
  const [rows, setRows] = useState<Row[]>([]);
  const pathname = usePathname();

  async function refresh() {
    try {
      const res = await fetch('/api/sessions', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { sessions: Row[] };
        setRows(data.sessions);
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [pathname]);

  return (
    <aside className="flex h-full w-64 flex-col border-r border-zinc-800 bg-zinc-900 p-3">
      <Link
        href="/chat/new"
        className="mb-3 rounded-md bg-emerald-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-emerald-500"
      >
        + New chat
      </Link>
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="p-2 text-xs text-zinc-500">No chats yet</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((r) => {
              const active = pathname === `/chat/${r.id}`;
              return (
                <li key={r.id}>
                  <Link
                    href={`/chat/${r.id}`}
                    className={`block truncate rounded-md px-2 py-1.5 text-sm ${
                      active
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-300 hover:bg-zinc-800/60'
                    }`}
                  >
                    {r.title ?? r.id.slice(0, 8)}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <form
        action="/api/auth/signout"
        method="post"
        className="mt-3 border-t border-zinc-800 pt-3"
      >
        <button
          type="submit"
          className="w-full rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800"
        >
          Sign out
        </button>
      </form>
    </aside>
  );
}
