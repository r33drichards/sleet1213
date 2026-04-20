import { auth } from '@/lib/auth';
import { renameSession } from '@/lib/ted';

export const runtime = 'nodejs';

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return new Response('unauthorized', { status: 401 });
  const body = (await req.json()) as { title?: string };
  if (typeof body.title !== 'string') {
    return new Response('title required', { status: 400 });
  }
  const { id } = await params;
  await renameSession(session.user.id, id, body.title);
  return Response.json({ ok: true });
}
