import { redirect } from 'next/navigation';
import { auth, signIn } from '@/lib/auth';

export default async function LoginPage() {
  const session = await auth();
  if (session?.user?.id) redirect('/chat/new');

  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <form
        action={async () => {
          'use server';
          await signIn('keycloak', { redirectTo: '/chat/new' });
        }}
        className="flex flex-col items-center gap-6 rounded-xl border border-zinc-800 bg-zinc-900 p-10"
      >
        <h1 className="text-2xl font-semibold">Ted</h1>
        <p className="text-sm text-zinc-400">Sign in to continue</p>
        <button
          type="submit"
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Sign in with Keycloak
        </button>
      </form>
    </div>
  );
}
