import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { db } from './db/client';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/(.*)',
  '/',
  '/access-denied',
  '/complete-profile'
]);

export default clerkMiddleware(async (auth, req) => {
  // Allow public routes
  if (isPublicRoute(req)) return;

  const { userId } = await auth();

  if (!userId) {
    // Protect page if no user
    auth.protect();
    return;
  }

  // 🔹 Check age in DB
  const user = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
  });

  if (!user || !user.age) {
    return NextResponse.redirect(new URL('/complete-profile', req.url));
  }

  if (user.age < 18) {
    return NextResponse.redirect(new URL('/access-denied', req.url));
  }

  // Allow access
  auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
