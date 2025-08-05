import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { db } from './db/client';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

// ✅ Liste des routes publiques
const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/(.*)',

  '/',                 // Page d'accueil
  '/casino',           // Page Casino
  '/casino/poker',     // Poker
  '/casino/blackjack', // Blackjack
  '/casino/roulette',  // Roulette (si tu en as une)
  '/casino/uno',       // Uno (si tu en as une)

  '/access-denied',
  '/complete-profile'
]);

export default clerkMiddleware(async (auth, req) => {
  // ✅ Autorise les routes publiques
  if (isPublicRoute(req)) return;

  const { userId } = await auth();

  if (!userId) {
    auth.protect(); // Redirige vers sign-in si page protégée
    return;
  }

  // 🔹 Vérifie l’âge dans la DB
  const user = await db.query.users.findFirst({
    where: eq(users.clerkId, userId),
  });

  if (!user || !user.age) {
    return NextResponse.redirect(new URL('/complete-profile', req.url));
  }

  if (user.age < 18) {
    return NextResponse.redirect(new URL('/access-denied', req.url));
  }

  // ✅ Autorise les routes protégées
  auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
