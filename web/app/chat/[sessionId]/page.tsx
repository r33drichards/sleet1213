import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getSessionMessages } from '@/lib/ted';
import Sidebar from '@/components/Sidebar';
import ChatThread from '@/components/ChatThread';
import ChatHeader from '@/components/ChatHeader';

export default async function ChatPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const { sessionId } = await params;

  // Pre-load committed history from ted/Postgres. Empty for a brand-new
  // session id (ted returns 404 → we treat as []).
  const initialMessages = await getSessionMessages(session.user.id, sessionId);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex flex-1 flex-col">
        <ChatHeader sessionId={sessionId} />
        <div className="flex-1 min-h-0">
          <ChatThread sessionId={sessionId} initialMessages={initialMessages} />
        </div>
      </main>
    </div>
  );
}
