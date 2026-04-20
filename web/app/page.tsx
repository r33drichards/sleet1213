import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export default async function Home() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  redirect('/chat/new');
}
