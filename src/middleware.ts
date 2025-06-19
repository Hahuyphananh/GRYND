import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/sync-user',
  '/',
  '/casino'
]);

export default clerkMiddleware((auth, req) => {
  if (isPublicRoute(req)) {
    return; // ✅ Allow public routes to pass through
  }
  auth.protect(); // ✅ Protect everything else
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
