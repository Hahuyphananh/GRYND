import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/(.*)',

  '/',                  // Homepage
  '/casino',
  '/casino/poker',
  '/casino/blackjack',
  '/casino/roulette',
  '/casino/uno',

  '/access-denied',
  '/complete-profile',
]);

export default clerkMiddleware(async (auth, req) => {
  // ✅ Allow public routes immediately
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  // ✅ Protect private routes
  const { userId, sessionClaims } = await auth();

  if (!userId) {
    // Redirect to sign-in if not authenticated
    return NextResponse.redirect(new URL('/sign-in', req.url));
  }

  // ✅ Extract age from session claims (set during profile completion)
  const age = sessionClaims?.age;

  if (!age) {
    // Redirect to complete profile if missing
    return NextResponse.redirect(new URL('/complete-profile', req.url));
  }

  if (Number(age) < 18) {
    // Redirect underage users
    return NextResponse.redirect(new URL('/access-denied', req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
