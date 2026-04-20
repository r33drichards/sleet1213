import { auth } from '@/lib/auth';

export default auth((req) => {
  const path = req.nextUrl.pathname;
  const isPublic =
    path === '/login' ||
    path.startsWith('/api/auth') ||
    path.startsWith('/_next') ||
    path === '/favicon.ico';
  if (!req.auth && !isPublic) {
    const url = new URL('/login', req.url);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
