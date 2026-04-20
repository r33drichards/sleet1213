import { auth } from '@/lib/auth';
import { getSessionMessages } from '@/lib/ted';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const { id } = await params;
  const messages = await getSessionMessages(session.user.id, id);
  return Response.json({ sessionId: id, messages });
}
