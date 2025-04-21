import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Define protected routes (all others will be public)
const isProtectedRoute = createRouteMatcher([
  '/(.*)',  // Protect all dashboard routes
  '/profile(.*)'
]);

export default clerkMiddleware((auth, req) => {
  if (isProtectedRoute(req)) {
    (async () => {
      const authObject = await auth();
    })();
  }
});

export const config = {
  matcher: ['/((?!.*\\..*|_next).*)', '/', '/(api|trpc)(.*)'],
};