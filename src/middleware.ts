import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextFetchEvent, NextRequest, NextResponse } from 'next/server';
import { cleanupRateLimitStore, consumeRateLimit, type LimitConfig } from './lib/security/rateLimit';
import { auditLog } from './lib/security/auditLog';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/(.*)',

  '/',
  '/casino',
  '/sport',
  '/sport/match/(.*)',
  '/sync',
  '/Classement',
  '/profil',
  '/casino/poker',
  '/casino/blackjack',
  '/casino/roulette',
  '/casino/uno(.*)',
  '/casino/plinko',
  '/casino/mines',
  '/casino/crash',
  '/casino/chess(.*)',
  '/casino/slots(.*)',
  '/casino/coin-flip',
  '/casino/keno',
  '/casino/rps',
  '/access-denied',
  '/complete-profile',
  '/casino/poker/multi(.*)',
  '/casino/tanks(.*)',
  '/casino/connect-four(.*)',
  '/casino/lane-runner(.*)',
]);

const API_ROUTE_LIMITS: Array<{ pattern: RegExp; config: LimitConfig }> = [
  { pattern: /^\/api\/(webhooks\/clerk|debug-env)/, config: { windowMs: 60_000, max: 20 } },
  { pattern: /^\/api\//, config: { windowMs: 60_000, max: 120 } },
];

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getClientIp(req: Request) {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || 'unknown';
  }
  return req.headers.get('x-real-ip') || 'unknown';
}

function getLimitForPath(pathname: string): LimitConfig | null {
  for (const routeLimit of API_ROUTE_LIMITS) {
    if (routeLimit.pattern.test(pathname)) {
      return routeLimit.config;
    }
  }
  return null;
}

function applySecurityHeaders(response: NextResponse) {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Keep CSP strict enough for safety but compatible with current UI.
response.headers.set(
  'Content-Security-Policy',
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' https://*.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com https:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data: blob: https:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self' https: wss:; " +
  "frame-src 'self' https://challenges.cloudflare.com https://*.clerk.com https://*.clerk.accounts.dev; " +
  "worker-src 'self' blob:; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'"
);

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  return response;
}

function isSameOriginMutation(req: Request) {
  const origin = req.headers.get('origin');
  const requestOrigin = req.headers.get('x-forwarded-proto')
    ? `${req.headers.get('x-forwarded-proto')}://${req.headers.get('host')}`
    : req.url ? new URL(req.url).origin : null;

  if (origin && requestOrigin && origin === requestOrigin) {
    return true;
  }

  const fetchSite = (req.headers.get('sec-fetch-site') || '').toLowerCase();
  return !origin && (fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none' || fetchSite === '');
}

const middlewareHandler = async (auth: () => Promise<any>, req: NextRequest) => {
  cleanupRateLimitStore();
  const pathname = req.nextUrl.pathname;
  const ip = getClientIp(req);

  if (pathname.startsWith('/api/')) {
    const limit = getLimitForPath(pathname);
    if (limit) {
      const { userId } = await auth();
      const baseKey = `${req.method}:${pathname}`;

      const ipResult = await consumeRateLimit(`${baseKey}:ip:${ip}`, limit);
      const userResult = userId
        ? await consumeRateLimit(`${baseKey}:user:${userId}`, {
            windowMs: limit.windowMs,
            max: Math.max(Math.floor(limit.max / 2), 30),
          })
        : null;

      const violated = !ipResult.allowed || (userResult ? !userResult.allowed : false);
      const activeResult = userResult && !userResult.allowed ? userResult : ipResult;

      if (violated) {
        const retryAfterSeconds = Math.ceil((activeResult.resetAt - Date.now()) / 1000);
        auditLog('rate_limit_exceeded', {
          ip,
          userId: userId ?? null,
          path: pathname,
          method: req.method,
          retryAfterSeconds,
        });
        return applySecurityHeaders(
          NextResponse.json(
            {
              success: false,
              error: 'Too many requests. Please slow down and retry shortly.',
              retryAfterSeconds,
            },
            {
              status: 429,
              headers: {
                'Retry-After': String(Math.max(retryAfterSeconds, 1)),
                'X-RateLimit-Limit': String(activeResult.limit),
                'X-RateLimit-Remaining': String(activeResult.remaining),
                'X-RateLimit-Reset': String(activeResult.resetAt),
              },
            },
          ),
        );
      }
    }

    if (MUTATION_METHODS.has(req.method) && !pathname.startsWith('/api/webhooks/')) {
      if (!isSameOriginMutation(req)) {
        auditLog('csrf_blocked', { ip, path: pathname, method: req.method });
        return applySecurityHeaders(
          NextResponse.json(
            { success: false, error: 'CSRF validation failed.' },
            { status: 403 },
          ),
        );
      }
    }

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.headers.get('content-type') || '';
      if (!contentType.includes('application/json') && !pathname.startsWith('/api/webhooks/')) {
        return applySecurityHeaders(
          NextResponse.json(
            { success: false, error: 'Invalid content type. Expected application/json.' },
            { status: 415 },
          ),
        );
      }

      const contentLength = Number(req.headers.get('content-length') || '0');
      if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
        return applySecurityHeaders(
          NextResponse.json(
            { success: false, error: 'Payload too large.' },
            { status: 413 },
          ),
        );
      }
    }
  }

  if (isPublicRoute(req)) {
    return applySecurityHeaders(NextResponse.next());
  }

  const { userId, sessionClaims } = await auth();

if (!userId) {
  auditLog('auth_required_redirect', { ip, path: pathname });
  return applySecurityHeaders(
    NextResponse.redirect(new URL('/sign-in', req.url))
  );
}

// ONLY enforce age on protected app routes, NOT on /sync or onboarding
const isOnboardingOrSync =
  pathname.startsWith('/sync') ||
  pathname.startsWith('/complete-profile');

if (!isOnboardingOrSync) {
  const age = sessionClaims?.age;

  if (!age) {
    auditLog('missing_age_claim', { userId, ip, path: pathname });

    return applySecurityHeaders(
      NextResponse.redirect(new URL('/complete-profile', req.url))
    );
  }

  if (Number(age) < 18) {
    auditLog('underage_redirect', { userId, ip, path: pathname, age: Number(age) });

    return applySecurityHeaders(
      NextResponse.redirect(new URL('/access-denied', req.url))
    );
  }
}

  return applySecurityHeaders(NextResponse.next());
};

const clerkProtectedMiddleware = clerkMiddleware(middlewareHandler);
const hasClerkSecretKey = Boolean(process.env.CLERK_SECRET_KEY);

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  if (!hasClerkSecretKey) {
    return applySecurityHeaders(NextResponse.next());
  }

  try {
    return await clerkProtectedMiddleware(req, event);
  } catch (error) {
    console.error('[middleware] Clerk middleware invocation failed; returning safe response.', error);
    return applySecurityHeaders(NextResponse.next());
  }
}

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
