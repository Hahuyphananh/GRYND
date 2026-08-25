import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextFetchEvent, NextRequest, NextResponse } from "next/server";
import {
  cleanupRateLimitStore,
  consumeRateLimit,
  type LimitConfig,
} from "./lib/security/rateLimit";
import { auditLog } from "./lib/security/auditLog";
import { isAdmin } from "./lib/auth/isAdmin";
import { isMaintenanceMode } from "./lib/security/maintenance";
import { hasRecentMfa } from "./lib/auth/requireMfa";
import { ADMIN_MFA_COOKIE, verifyAdminMfaToken } from "./lib/auth/adminMfa";
import { db } from "./db";
import { users } from "./db/schema";
import { eq } from "drizzle-orm";
import { cacheGet, cacheSet } from "./lib/redis/cache";
import { CacheKeys, CacheTTL } from "./lib/redis/keys";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/(.*)",
  "/ingest(.*)",
  "/monitoring",
  "/health",

  "/",
  "/casino",
  "/games",
  "/sync",
  "/thank-you",
  "/Classement",
  "/profil(.*)",
  "/casino/blackjack(.*)",
  "/casino/roulette(.*)",
  "/casino/uno(.*)",
  "/casino/neon-flush(.*)",
  "/uno/multiplayer(.*)",
  "/casino/plinko(.*)",
  "/casino/mines-pvp(.*)",
  // /casino/crash still redirects to the PVP Crash Arena, so it stays public
  "/casino/crash",
  "/casino/crash-arena(.*)",
  "/casino/chess(.*)",
  "/casino/keno",
  "/casino/keno-pvp(.*)",
  "/casino/rps(.*)",
  "/access-denied",
  "/complete-profile",
  "/maintenance",
  "/casino/poker/multi(.*)",
  "/casino/dice-duel(.*)",
  "/casino/connect-four(.*)",
  "/casino/dots-and-boxes(.*)",
  "/casino/lane-runner(.*)",
  "/profile(.*)",
  "/casino/pool-masters(.*)",
  "/casino/hex-duel(.*)",
  "/casino/dice-flush(.*)",
  "/casino/odds(.*)",
  "/casino/memory-grid(.*)",
  "/casino/precision(.*)",
  // /games/* mirrors of the /casino/* routes — middleware runs before the
  // rewrite, so both URL styles need the same access rules.
  "/games/blackjack(.*)",
  "/games/roulette(.*)",
  "/games/uno(.*)",
  "/games/neon-flush(.*)",
  "/games/plinko(.*)",
  "/games/mines-pvp(.*)",
  "/games/crash",
  "/games/crash-arena(.*)",
  "/games/chess(.*)",
  "/games/keno",
  "/games/keno-pvp(.*)",
  "/games/rps(.*)",
  "/games/poker/multi(.*)",
  "/games/dice-duel(.*)",
  "/games/connect-four(.*)",
  "/games/dots-and-boxes(.*)",
  "/games/lane-runner(.*)",
  "/games/pool-masters(.*)",
  "/games/hex-duel(.*)",
  "/games/dice-flush(.*)",
  "/games/odds(.*)",
  "/games/memory-grid(.*)",
  "/games/precision(.*)",
  "/sentry-example-page",

  // Legal / policy pages
  "/security-policy",
  "/privacy-policy",
  "/terms",
  "/fair-play",
  "/accessibility",

  // Public pages
  "/contact",
  "/reviews",
  "/faq",
]);

const API_ROUTE_LIMITS: Array<{ pattern: RegExp; config: LimitConfig }> = [
  {
    pattern: /^\/api\/webhooks\/resend$/,
    config: { windowMs: 60_000, max: 60 },
  },
  {
    pattern: /^\/api\/(webhooks\/clerk|debug-env)/,
    config: { windowMs: 60_000, max: 20 },
  },
  {
    // Prevent abuse: only allow a handful of test emails per minute.
    pattern: /^\/api\/email\/test$/,
    config: { windowMs: 60_000, max: 5 },
  },
  {
    // Public contact form — protect against spam.
    pattern: /^\/api\/contact$/,
    config: { windowMs: 60_000, max: 10 },
  },
  {
    // Internal system notifications — restrict to sane limits.
    pattern: /^\/api\/system\/notify$/,
    config: { windowMs: 60_000, max: 30 },
  },
  {
    // Slots PvP / Plinko PvP match pages poll /status every 800ms
    // (~75 requests/min) on top of stop / launch actions — well beyond
    // the generic 60/min per-user cap. The generic cap silently froze
    // the board mid-round: with the status polls rate-limited, the
    // client could never reconcile, so every STOP click 409'd against
    // the stale board ("can't click stop"). These polling-heavy flows
    // get their own headroom.
    pattern: /^\/api\/(plinko-pvp|keno-pvp)\//,
    config: { windowMs: 60_000, max: 300 },
  },
  { pattern: /^\/api\//, config: { windowMs: 60_000, max: 120 } },
];

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getClientIp(req: Request) {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  return req.headers.get("x-real-ip") || "unknown";
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
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  // Keep CSP strict enough for safety but compatible with current UI.
  //
  // `'unsafe-eval'` is REQUIRED in development (Node `next dev`):
  //   - React uses eval() for callstack reconstruction / DevTools
  //     helpers. Without it, React's red-box and action wiring break.
  //   - Clerk's @clerk/ui bundle is built with Vite in dev mode and
  //     uses eval() at module-boundary seams; the dev sign-in/sign-up
  //     flows silently no-op without it, which is why auth "works in
  //     production but not localhost" — production bundles are
  //     pre-compiled and never call eval().
  // Production keeps eval() blocked for security.
  const scriptSrc =
    process.env.NODE_ENV === "development"
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com https:; "
      : "script-src 'self' 'unsafe-inline' https://*.clerk.com https://*.clerk.accounts.dev https://challenges.cloudflare.com https:; ";

  response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
      scriptSrc +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.tawk.to https://cdn.jsdelivr.net; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data: https://fonts.gstatic.com https://*.tawk.to; " +
      "connect-src 'self' https: wss:; " +
      "frame-src 'self' https://challenges.cloudflare.com https://*.clerk.com https://*.clerk.accounts.dev https://*.tawk.to https://embed.tawk.to; " +
      "worker-src 'self' blob:; " +
      "frame-ancestors 'self'; " +
      "base-uri 'self'; " +
      "form-action 'self'"
  );

  if (process.env.NODE_ENV === "production") {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }

  return response;
}

function isSameOriginMutation(req: Request) {
  const origin = req.headers.get("origin");
  const requestOrigin = req.headers.get("x-forwarded-proto")
    ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("host")}`
    : req.url
      ? new URL(req.url).origin
      : null;

  if (origin && requestOrigin && origin === requestOrigin) {
    return true;
  }

  const fetchSite = (req.headers.get("sec-fetch-site") || "").toLowerCase();
  return (
    !origin &&
    (fetchSite === "same-origin" ||
      fetchSite === "same-site" ||
      fetchSite === "none" ||
      fetchSite === "")
  );
}

const middlewareHandler = async (auth: () => Promise<any>, req: NextRequest) => {
  cleanupRateLimitStore();
  const pathname = req.nextUrl.pathname;
  const ip = getClientIp(req);

  // ── Maintenance-mode kill switch ──────────────────────────────────────
  // When the flag is on, everyone except admins is redirected to the
  // maintenance page. /admin and /api/admin stay reachable so the admin
  // can flip the flag back off without a redeploy. The check is skipped
  // entirely when the flag is off (cached, one flag lookup per ~10s).
  if (pathname !== "/maintenance" && (await isMaintenanceMode())) {
    const isAdminPath =
      pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
    let allowed = isAdminPath;

    if (!allowed) {
      try {
        const { userId } = await auth();
        if (userId) {
          const adminIds = (process.env.CHAT_ADMIN_CLERK_IDS || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          allowed =
            adminIds.length > 0 ? adminIds.includes(userId) : await isAdmin(userId);
        }
      } catch {
        allowed = false;
      }
    }

    if (!allowed) {
      auditLog("maintenance_redirect", { ip, path: pathname });
      return applySecurityHeaders(NextResponse.redirect(new URL("/maintenance", req.url)));
    }
  }

  if (pathname.startsWith("/api/")) {
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
        auditLog("rate_limit_exceeded", {
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
              error: "Too many requests. Please slow down and retry shortly.",
              retryAfterSeconds,
            },
            {
              status: 429,
              headers: {
                "Retry-After": String(Math.max(retryAfterSeconds, 1)),
                "X-RateLimit-Limit": String(activeResult.limit),
                "X-RateLimit-Remaining": String(activeResult.remaining),
                "X-RateLimit-Reset": String(activeResult.resetAt),
              },
            }
          )
        );
      }
    }

    if (MUTATION_METHODS.has(req.method) && !pathname.startsWith("/api/webhooks/")) {
      if (!isSameOriginMutation(req)) {
        auditLog("csrf_blocked", { ip, path: pathname, method: req.method });
        return applySecurityHeaders(
          NextResponse.json({ success: false, error: "CSRF validation failed." }, { status: 403 })
        );
      }
    }

    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const contentType = req.headers.get("content-type") || "";
      if (!contentType.includes("application/json") && !pathname.startsWith("/api/webhooks/")) {
        return applySecurityHeaders(
          NextResponse.json(
            {
              success: false,
              error: "Invalid content type. Expected application/json.",
            },
            { status: 415 }
          )
        );
      }

      const contentLength = Number(req.headers.get("content-length") || "0");
      if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
        return applySecurityHeaders(
          NextResponse.json({ success: false, error: "Payload too large." }, { status: 413 })
        );
      }
    }
  }

  if (isPublicRoute(req)) {
    return applySecurityHeaders(NextResponse.next());
  }

  const { userId, sessionClaims, factorVerificationAge } = await auth();

  if (!userId) {
    auditLog("auth_required_redirect", { ip, path: pathname });
    return applySecurityHeaders(NextResponse.redirect(new URL("/sign-in", req.url)));
  }

  // ONLY enforce age on protected app routes, NOT on /sync, onboarding,
  // or the admin dashboard. /admin stays authenticated here and is DB-admin
  // gated by src/app/admin/page.tsx before the dashboard can render.
  const skipsAgeGate =
    pathname.startsWith("/sync") ||
    pathname.startsWith("/complete-profile") ||
    pathname.startsWith("/admin");

  if (!skipsAgeGate) {
    // Prefer the session claim when a JWT template provides one. When it
    // does, the age gate costs zero DB work per request.
    let age = sessionClaims?.age;

    if (age === undefined || age === null) {
      // Fall back to a cached `users.age` lookup so a protected page load
      // doesn't hit Neon on every navigation. Age only changes on a
      // birthdate edit (rare), so a short TTL is plenty. When Redis/KV is
      // not configured, cacheGet/cacheSet no-op and we do the DB read once
      // per request, exactly as before.
      age = await cacheGet<number | null>(CacheKeys.userAge(userId));
      if (age === null || age === undefined) {
        const user = await db.query.users.findFirst({
          where: eq(users.clerkId, userId),
          columns: { age: true },
        });
        age = user?.age ?? null;
        if (age !== null && age !== undefined) {
          await cacheSet(CacheKeys.userAge(userId), age, CacheTTL.userAge).catch(() => {});
        }
      }
    }

    if (!age) {
      auditLog("missing_age_claim", { userId, ip, path: pathname });

      return applySecurityHeaders(NextResponse.redirect(new URL("/complete-profile", req.url)));
    }

    if (Number(age) < 18) {
      auditLog("underage_redirect", {
        userId,
        ip,
        path: pathname,
        age: Number(age),
      });

      return applySecurityHeaders(NextResponse.redirect(new URL("/access-denied", req.url)));
    }
  }

  // Admin route gate: only users with the admin badge (DB-backed is_admin) may access.
  // 1. Fast path: env var allowlist (CHAT_ADMIN_CLERK_IDS) — instant allow.
  // 2. DB-backed path: queries the `is_admin` column on the users table.
  // Both the middleware AND the page component (src/app/admin/page.tsx) enforce
  // this check so non-admin users can never reach the dashboard.
  if (pathname.startsWith("/admin")) {
    const adminIds = (process.env.CHAT_ADMIN_CLERK_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (adminIds.length > 0 && adminIds.includes(userId)) {
      // Fast path: user is in env var allowlist — let through immediately.
    } else {
      // DB-backed check — the source of truth for admin badges.
      const admin = await isAdmin(userId);
      if (!admin) {
        auditLog("admin_access_blocked", {
          userId,
          ip,
          path: pathname,
        });
        return applySecurityHeaders(
          NextResponse.redirect(new URL("/", req.url))
        );
      }
    }
  }

  // MFA enforcement for all admin surfaces (defense in depth — the admin
  // page component re-checks the same condition). The session must have
  // verified a second factor recently; anything else fails closed.
  // `/admin/mfa-required` itself is exempt so the gate page can render.
  if (
    (pathname.startsWith("/admin") && pathname !== "/admin/mfa-required") ||
    pathname.startsWith("/api/admin")
  ) {
    const adminMfaToken = req.cookies.get(ADMIN_MFA_COOKIE)?.value;
    if (
      !hasRecentMfa(factorVerificationAge) &&
      !(await verifyAdminMfaToken(adminMfaToken, userId))
    ) {
      if (pathname.startsWith("/api/admin")) {
        auditLog("admin_mfa_required", { userId, ip, path: pathname });
        return applySecurityHeaders(
          NextResponse.json(
            { success: false, error: "MFA required for admin access." },
            { status: 403 }
          )
        );
      }
      auditLog("admin_mfa_required_redirect", { userId, ip, path: pathname });
      return applySecurityHeaders(
        NextResponse.redirect(new URL("/admin/mfa-required", req.url))
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
    console.error(
      "[middleware] Clerk middleware invocation failed; returning safe response.",
      error
    );
    return applySecurityHeaders(NextResponse.next());
  }
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
