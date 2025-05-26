import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// Define public routes that don't require authentication
const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/sync-user',
]);

export default clerkMiddleware((auth, req) => {
  // Protect all routes except the ones defined above
  if (!isPublicRoute(req)) {
    auth.protect(); 
  }
});

export const config = {
  matcher: [
    // Match all dynamic routes except static files
    '/((?!_next|.*\\..*).*)',
    // Match API and trpc routes
    '/(api|trpc)(.*)',
  ],
};
