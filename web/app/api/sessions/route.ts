import { auth } from '@/lib/auth';
import { listSessions } from '@/lib/ted';

export const runtime = 'nodejs';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const sessions = await listSessions(session.user.id);
  return Response.json({ sessions });
}
