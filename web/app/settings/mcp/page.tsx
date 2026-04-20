import { auth } from '@/lib/auth';
import { listMcpServers } from '@/lib/ted';
import { redirect } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import McpServersClient from './McpServersClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function McpSettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const servers = await listMcpServers(session.user.id);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl p-6">
          <h1 className="mb-1 text-2xl font-semibold">MCP servers</h1>
          <p className="mb-6 text-sm text-zinc-400">
            Remote MCP servers Claude can call during your chats. Changes
            take effect on your next message.
          </p>
          <McpServersClient initial={servers} />
        </div>
      </main>
    </div>
  );
}
