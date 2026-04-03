import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { cleanupRateLimitStore, consumeRateLimit, type LimitConfig } from './lib/security/rateLimit';
import { auditLog } from './lib/security/auditLog';

const CSRF_COOKIE_NAME = 'csrf_token';

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
  '/casino/uno',
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
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );

  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  return response;
}

function finalizeResponse(req: Request, response: NextResponse) {
  const secured = applySecurityHeaders(response);

  const existingToken = req.headers.get('cookie')?.includes(`${CSRF_COOKIE_NAME}=`);
  if (!existingToken && !MUTATION_METHODS.has(req.method)) {
    secured.cookies.set(CSRF_COOKIE_NAME, crypto.randomUUID(), {
      httpOnly: false,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
  }

  return secured;
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

function hasValidCsrfToken(req: Request) {
  const cookieHeader = req.headers.get('cookie') || '';
  const tokenMatch = cookieHeader.match(new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`));
  const cookieToken = tokenMatch?.[1] || null;
  const headerToken = req.headers.get('x-csrf-token');
  return Boolean(cookieToken && headerToken && cookieToken === headerToken);
}

export default clerkMiddleware(async (auth, req) => {
  cleanupRateLimitStore();
  const pathname = req.nextUrl.pathname;
  const ip = getClientIp(req);

  if (pathname.startsWith('/api/')) {
    const limit = getLimitForPath(pathname);
    if (limit) {
      const { userId } = await auth();
      const baseKey = `${req.method}:${pathname}`;

      const ipResult = consumeRateLimit(`${baseKey}:ip:${ip}`, limit);
      const userResult = userId
        ? consumeRateLimit(`${baseKey}:user:${userId}`, {
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
        return finalizeResponse(
          req,
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
      const validToken = hasValidCsrfToken(req);
      if (!validToken && !isSameOriginMutation(req)) {
        auditLog('csrf_blocked', { ip, path: pathname, method: req.method });
        return finalizeResponse(
          req,
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
        return finalizeResponse(
          req,
          NextResponse.json(
            { success: false, error: 'Invalid content type. Expected application/json.' },
            { status: 415 },
          ),
        );
      }

      const contentLength = Number(req.headers.get('content-length') || '0');
      if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
        return finalizeResponse(
          req,
          NextResponse.json(
            { success: false, error: 'Payload too large.' },
            { status: 413 },
          ),
        );
      }
    }
  }

  if (isPublicRoute(req)) {
    return finalizeResponse(req, NextResponse.next());
  }

  const { userId, sessionClaims } = await auth();

  if (!userId) {
    auditLog('auth_required_redirect', { ip, path: pathname });
    return finalizeResponse(req, NextResponse.redirect(new URL('/sign-in', req.url)));
  }

  const age = sessionClaims?.age;

  if (!age) {
    auditLog('missing_age_claim', { userId, ip, path: pathname });
    return finalizeResponse(req, NextResponse.redirect(new URL('/complete-profile', req.url)));
  }

  if (Number(age) < 18) {
    auditLog('underage_redirect', { userId, ip, path: pathname, age: Number(age) });
    return finalizeResponse(req, NextResponse.redirect(new URL('/access-denied', req.url)));
  }

  return finalizeResponse(req, NextResponse.next());
});

export const config = {
  matcher: [
    '/((?!_next|.*\\..*).*)',
    '/(api|trpc)(.*)',
  ],
};
