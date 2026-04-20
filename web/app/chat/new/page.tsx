import { redirect } from 'next/navigation';
import { randomUUID } from 'crypto';
import { auth } from '@/lib/auth';

/**
 * "New chat" server page. Mints a UUID on the server so the session id is
 * predictable in the URL; the DB row is created lazily by ted on the first
 * POST /message. That keeps the "new" flow free of empty sessions if the
 * user lands here but never sends anything.
 */
export default async function NewChat() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const id = randomUUID();
  redirect(`/chat/${id}`);
}
