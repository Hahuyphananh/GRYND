import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/(.*)',
  '/',
  '/casino',
  '/casino/poker',
  '/casino/blackjack',
  '/casino/roulette',
  '/casino/uno',
  '/access-denied',
  '/complete-profile',
]);

export default clerkMiddleware((auth, req) => {
  if (isPublicRoute(req)) {
    return NextResponse.next(); // ✅ Always return a response
  }

  auth.protect();
  return NextResponse.next(); // ✅ Also return for protected routes
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
