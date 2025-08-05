import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// ✅ Liste des routes publiques
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
  '/complete-profile'
]);

export default clerkMiddleware((auth, req) => {
  // ✅ Autorise immédiatement les routes publiques
  if (isPublicRoute(req)) return;

  // ✅ Protège seulement les pages privées
  auth.protect();
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
