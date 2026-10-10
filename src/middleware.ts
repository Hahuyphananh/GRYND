import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextFetchEvent, NextRequest, NextResponse } from "next/server";
import {
  cleanupRateLimitStore,
  consumeRateLimit,
  type LimitConfig,
} from "./lib/security/rateLimit";
import { auditLog } from "./lib/security/auditLog";
import {
  edgeIsAdmin,
  edgeIsMaintenanceMode,
  edgeUserAge,
  edgeUserMfaEnabled,
} from "./lib/security/edgeFlags";
import { withTimeout } from "./lib/security/withTimeout";
import { hasRecentMfa } from "./lib/auth/requireMfa";
import {
  ADMIN_MFA_COOKIE,
  USER_MFA_COOKIE,
  verifyAdminMfaToken,
  verifyUserMfaToken,
} from "./lib/auth/adminMfa";
import { cacheGet, cacheSet } from "./lib/redis/cache";
import { CacheKeys, CacheTTL } from "./lib/redis/keys";
import { isGameLandingSlug } from "./lib/gameLandingPages";
import { isGuideSlug } from "./lib/guides";
import { COUNTRY_COOKIE, countryFromHeaders } from "./lib/consentRegions";

/**
 * A path with no route behind it, used only as a rewrite target so that an
 * unknown game slug is answered with the app's own 404 page (see the guard in
 * `middlewareHandler`). Nothing serves it, which is the point.
 */
const NOT_FOUND_SENTINEL = "/__unknown-game-slug";

/**
 * Playable casino/game routes — the single source of truth for
 * `isGameRoute()`. These are the exact same patterns the public matcher
 * below has always listed; they live here so the two lists cannot drift.
 *
 * Both URL styles are listed because next.config.js rewrites
 * /games/* → /casino/* (middleware runs before the rewrite) and 308s
 * /casino/* → /games/*, so a request can arrive with either prefix.
 */
const GAME_ROUTE_PATTERNS = [
  "/casino/uno(.*)",
  "/casino/neon-flush(.*)",
  // /uno is the top-level alias of the Uno game page.
  "/uno",
  "/casino/mines-pvp(.*)",
  "/casino/chess(.*)",
  // Keno carries a `(.*)` like every other game so that its play URL
  // (/games/keno/play, rewritten to /casino/keno) is classified as a game route
  // too. Without it the bare pattern matched only the lobby itself, so a
  // signed-out visitor pressing Play on the Keno landing page was bounced to
  // /sign-in while the same visitor reached the lobby on the other twenty
  // games — the exact inconsistency this list exists to prevent.
  "/casino/keno(.*)",
  "/casino/keno-pvp(.*)",
  "/casino/rps(.*)",
  "/casino/four-in-a-row(.*)",
  "/casino/dots-and-boxes(.*)",
  "/casino/lane-runner(.*)",
  "/casino/tower-arena(.*)",
  "/casino/pool-masters(.*)",
  "/casino/hex-duel(.*)",
  "/casino/dice-flush(.*)",
  "/casino/odds(.*)",
  "/casino/memory-grid(.*)",
  "/casino/precision(.*)",
  // Games added to the hub catalogue after this list was first written
  // (src/app/casino/PageClient.jsx `games[].href`). They are advertised on the
  // public hub, so a signed-out visitor must be able to READ their lobby as
  // well — keep this list in sync with that catalogue.
  "/casino/mini-golf(.*)",
  "/casino/speed-typing(.*)",
  "/casino/tic-tac-toe(.*)",
  "/casino/solitaire-duel(.*)",
  "/casino/sudoku-duel(.*)",
  // /games/* mirrors of the /casino/* routes.
  "/games/uno(.*)",
  "/games/neon-flush(.*)",
  "/games/mines-pvp(.*)",
  "/games/chess(.*)",
  "/games/keno(.*)",
  "/games/keno-pvp(.*)",
  "/games/rps(.*)",
  "/games/four-in-a-row(.*)",
  "/games/dots-and-boxes(.*)",
  "/games/lane-runner(.*)",
  "/games/tower-arena(.*)",
  "/games/pool-masters(.*)",
  "/games/hex-duel(.*)",
  "/games/dice-flush(.*)",
  "/games/odds(.*)",
  "/games/memory-grid(.*)",
  "/games/precision(.*)",
  "/games/mini-golf(.*)",
  "/games/speed-typing(.*)",
  "/games/tic-tac-toe(.*)",
  "/games/solitaire-duel(.*)",
  "/games/sudoku-duel(.*)",
] as const;

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
  // /welcome is the first-time onboarding flow shown to brand-new accounts
  // right after /sync. Like /sync and /thank-you it must stay reachable
  // BEFORE the user has set their age (/complete-profile gate) — the page
  // itself bounces signed-out visitors to the public home.
  "/welcome",
  // /welcome/questionnaire is the first stop of the signup hand-off
  // (/sync → questionnaire → /welcome), so it needs the exact same public
  // access as /welcome itself. The API it writes to lives under /api/*,
  // which is matched above.
  "/welcome/questionnaire(.*)",
  "/classement",
  "/profil(.*)",
  // Onboarding / auth / system pages that must stay reachable BEFORE a
  // player has an age record.
  "/access-denied",
  "/complete-profile",
  "/maintenance",
  "/mfa-required",
  "/profile(.*)",
  "/settings(.*)",

  // Every playable casino/game route — declared once in GAME_ROUTE_PATTERNS
  // above. Explicitly public today (no behaviour change); the patterns are
  // listed once so isGameRoute() and this matcher can never disagree.
  ...GAME_ROUTE_PATTERNS,
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
  // The guides library (src/lib/guides.ts). Public for the same reason /faq is:
  // it is a reading surface that helps a signed-out visitor decide whether to
  // play, and it must be indexable without a session. Matched with `(.*)` so
  // both /guides and /guides/<slug> are covered by one entry.
  "/guides(.*)",
  // GRYND PRO upgrade landing page — public so signed-out visitors can see the
  // offer and are routed through sign-up by the CTA.
  "/upgrade-pro",
  // Legacy Shop URL: now a redirect to /upgrade-pro, kept public so old links
  // (emails, bookmarks, Stripe returns) don't bounce through sign-in first.
  "/shop",
]);

const gameRouteMatcher = createRouteMatcher([...GAME_ROUTE_PATTERNS]);

/**
 * Classifies a pathname as a playable casino/game route — i.e. a route that
 * must require authentication and a verified 18+ age record.
 *
 * Returns true for the /casino/* and /games/* playable game routes (and
 * their sub-routes such as match/table/game ids). Onboarding and navigation
 * surfaces (/casino and /games hubs, /sync, /welcome*, /complete-profile,
 * /access-denied, legal pages) return false and stay public.
 *
 * NOTE: this is a pure classifier. Nothing calls it yet, so it changes no
 * request handling — the authentication and age-gate branches are untouched.
 */
export function isGameRoute(pathname: string): boolean {
  // Clerk's route matcher reads `req.nextUrl.pathname`; a minimal shell is
  // enough to reuse the exact same pattern semantics as isPublicRoute.
  return gameRouteMatcher({ nextUrl: { pathname } } as NextRequest);
}

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
    // Stripe webhook — Stripe can re-deliver event bursts; give it headroom
    // so legitimate events are never 429'd (idempotency handles replays).
    pattern: /^\/api\/webhooks\/stripe$/,
    config: { windowMs: 60_000, max: 300 },
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
    // Keno PvP match pages poll /status every 5s as a reconnect safety
    // net (socket broadcasts are the fast path). Even at 5s, ~12 req/min
    // per client on top of actions is above the generic 60/min per-user
    // cap. The generic cap silently froze the board mid-round: with the
    // status polls rate-limited, the client could never reconcile, so
    // every action 409'd against the stale board. These polling-heavy
    // flows get their own headroom.
    pattern: /^\/api\/(keno-pvp)\//,
    config: { windowMs: 60_000, max: 300 },
  },
  { pattern: /^\/api\//, config: { windowMs: 60_000, max: 120 } },
];

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// RFC 8058 one-click unsubscribe is a cross-origin POST from a mail client and
// is authorised by its HMAC-signed token (never a cookie), so the CSRF and
// application/json content-type guards deliberately don't apply to it.
const skipsCsrfGuards = (pathname: string) =>
  pathname.startsWith("/api/webhooks/") ||
  pathname === "/api/emails/unsubscribe";

/**
 * User-level MFA gate (Settings → Account Security). When a signed-in user
 * has the self-hosted email-OTP second factor enabled, every app page (public
 * included — wagering pages are public routes) requires a recent second-
 * factor verification: a Clerk factor, our signed user_mfa cookie, or an
 * admin_mfa cookie (so an admin with both flows enabled never bounces
 * between two MFA pages). Fail-open: if the flag can't be resolved, the
 * request passes — a DB/Redis hiccup must never lock players out.
 */
async function userMfaGate(
  req: NextRequest,
  pathname: string,
  authFn: () => Promise<{
    userId: string | null;
    factorVerificationAge: [number, number] | null;
  }>,
  authInfo?: { userId: string | null; factorVerificationAge: [number, number] | null },
) {
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname === "/mfa-required" ||
    pathname === "/complete-profile" ||
    pathname === "/access-denied" ||
    pathname === "/maintenance" ||
    pathname === "/admin/mfa-required"
  ) {
    return null;
  }

  let userId = authInfo?.userId ?? null;
  let factorVerificationAge = authInfo?.factorVerificationAge ?? null;
  if (!userId) {
    try {
      const a = await authFn();
      userId = a.userId ?? null;
      factorVerificationAge = a.factorVerificationAge ?? null;
    } catch {
      return null;
    }
  }
  if (!userId) return null;

  let enabled = false;
  try {
    const cached = await cacheGet<boolean>(CacheKeys.userMfa(userId));
    if (cached === null || cached === undefined) {
      enabled = await withTimeout(edgeUserMfaEnabled(userId), 1500, false);
      await cacheSet(CacheKeys.userMfa(userId), enabled, CacheTTL.userMfa).catch(() => {});
    } else {
      enabled = cached === true;
    }
  } catch {
    return null; // fail open
  }
  if (!enabled) return null;

  const adminToken = req.cookies.get(ADMIN_MFA_COOKIE)?.value;
  const userToken = req.cookies.get(USER_MFA_COOKIE)?.value;
  const satisfied =
    hasRecentMfa(factorVerificationAge) ||
    (await verifyUserMfaToken(userToken, userId)) ||
    (await verifyAdminMfaToken(adminToken, userId));
  if (satisfied) return null;

  auditLog("user_mfa_required_redirect", {
    userId,
    ip: getClientIp(req),
    path: pathname,
  });
  const redirectUrl = new URL("/mfa-required", req.url);
  redirectUrl.searchParams.set("redirect_url", pathname);
  return applySecurityHeaders(NextResponse.redirect(redirectUrl));
}

// `withTimeout` (imported above, shared with src/lib/auth/requireAgeVerified.ts)
// is always called here with a fail-open fallback: the proxy must never let a
// slow/hung DB round-trip block page delivery — that turns a DB hiccup into a
// site-wide "stuck loading" state (every request waits on the maintenance flag
// / age lookup before the first byte of HTML is sent). The API age gate makes
// the opposite choice on purpose and fails closed.

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
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' data: https://fonts.gstatic.com; " +
      "connect-src 'self' https: wss:; " +
      // AdSense serves each ad unit in a cross-origin iframe, so `frame-src`
      // — the one directive that is NOT wildcarded above — has to name its
      // hosts explicitly: googleads.g.doubleclick.net and the
      // safeframe/tpc.googlesyndication.com frames the ad units render in.
      // (script-src, img-src and connect-src already allow all of `https:`.)
      // Without these the loader still downloads and then silently fails to
      // paint a single ad. Only the pages in src/components/AdSenseScript.tsx
      // ever request them (see the page allow-list in tests/adsense.test.mjs).
      //
      // fundingchoicesmessages.google.com serves Google's certified consent
      // message (Privacy & messaging) shown to EEA/UK/Swiss visitors — see
      // src/lib/consentRegions.ts. Blocking it would leave those visitors
      // unable to consent at all, which is a revenue loss, not a privacy win.
      "frame-src 'self' https://challenges.cloudflare.com https://*.clerk.com https://*.clerk.accounts.dev https://js.stripe.com https://checkout.stripe.com https://*.stripe.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://fundingchoicesmessages.google.com; " +
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
  if (
    pathname !== "/maintenance" &&
    (await withTimeout(edgeIsMaintenanceMode(), 1500, false))
  ) {
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
            adminIds.length > 0 ? adminIds.includes(userId) : await edgeIsAdmin(userId);
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

  // ── An unknown /games/<slug> is a REAL 404 ────────────────────────────
  //
  // `/games/<slug>` is the public landing page for a game, and only the 21
  // slugs in src/lib/gameLandingPages.ts have one. Anything else must not be
  // answered with a 200.
  //
  // The page cannot do this itself. `notFound()` from a page runs after the
  // root `loading.tsx` Suspense boundary has already flushed the shell, so the
  // response status is committed as 200 and the body is not-found content — a
  // soft 404, which is exactly the thing crawlers punish. Declaring the slug
  // space up front in the middleware answers with a genuine 404 before any
  // rendering starts.
  //
  // Two behaviours fall out of it, both intended:
  //   * the request is REWRITTEN, not redirected, so the URL the visitor typed
  //     stays in the address bar while the 404 status is returned;
  //   * it applies whatever the session is. Previously an unknown slug that the
  //     game-route patterns did not recognise (/games/typo) was bounced to
  //     /sign-in like any other unknown path, and one that they DID recognise
  //     (/games/chess-game, via the /games/chess(.*) prefix) rendered a 200.
  //     Neither is right for a URL that has no page.
  //
  // This adds a gate; it changes no authentication decision. The slug check is a
  // pure lookup against the same list the pages and the sitemap use.
  const unknownGameSlug = /^\/games\/([^/]+)\/?$/.exec(pathname);
  if (unknownGameSlug && !isGameLandingSlug(unknownGameSlug[1])) {
    return applySecurityHeaders(
      NextResponse.rewrite(new URL(NOT_FOUND_SENTINEL, req.url)),
    );
  }

  // Same rule for the guides library: `/guides/<slug>` only exists for the
  // slugs in src/lib/guides.ts, and anything else must be a real 404. Measured
  // behaviour is the same as the game pages — the route's own `dynamicParams =
  // false` is not enough on this app's streaming root layout, which commits a
  // 200 before the page can reject the param — so the slug space is declared
  // here in the middleware, before any rendering starts.
  const unknownGuideSlug = /^\/guides\/([^/]+)\/?$/.exec(pathname);
  if (unknownGuideSlug && !isGuideSlug(unknownGuideSlug[1])) {
    return applySecurityHeaders(
      NextResponse.rewrite(new URL(NOT_FOUND_SENTINEL, req.url)),
    );
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

    if (MUTATION_METHODS.has(req.method) && !skipsCsrfGuards(pathname)) {
      if (!isSameOriginMutation(req)) {
        auditLog("csrf_blocked", { ip, path: pathname, method: req.method });
        return applySecurityHeaders(
          NextResponse.json({ success: false, error: "CSRF validation failed." }, { status: 403 })
        );
      }
    }

    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const contentType = req.headers.get("content-type") || "";
      if (!contentType.includes("application/json") && !skipsCsrfGuards(pathname)) {
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

  // Admin API routes require authentication and MFA step-up, so they must
  // be handled BEFORE the public-route branch (which would otherwise match
  // them via the broad /api/(.*) pattern and return early).
  if (pathname.startsWith("/api/admin")) {
    const { userId, factorVerificationAge } = await auth();
    if (!userId) {
      auditLog("admin_api_auth_required", { ip, path: pathname });
      return applySecurityHeaders(
        NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
      );
    }

    // Verify the user is an admin (DB-backed check or env var allowlist).
    const adminIds = (process.env.CHAT_ADMIN_CLERK_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const isAdminUser =
      (adminIds.length > 0 && adminIds.includes(userId)) || (await edgeIsAdmin(userId));

    if (!isAdminUser) {
      auditLog("admin_api_access_blocked", { userId, ip, path: pathname });
      return applySecurityHeaders(
        NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 })
      );
    }

    // Enforce admin MFA step-up: the session must have verified a second
    // factor recently, or hold a valid admin_mfa / user_mfa cookie.
    const adminMfaToken = req.cookies.get(ADMIN_MFA_COOKIE)?.value;
    const userMfaToken = req.cookies.get(USER_MFA_COOKIE)?.value;
    if (
      !hasRecentMfa(factorVerificationAge) &&
      !(await verifyAdminMfaToken(adminMfaToken, userId)) &&
      !(await verifyUserMfaToken(userMfaToken, userId))
    ) {
      auditLog("admin_mfa_required", { userId, ip, path: pathname });
      return applySecurityHeaders(
        NextResponse.json(
          { success: false, error: "MFA required for admin access." },
          { status: 403 }
        )
      );
    }

    // Admin API request is authenticated, authorized, and MFA-verified.
    return applySecurityHeaders(NextResponse.next());
  }

  // Playable game routes are browsable while SIGNED OUT but still fall through
  // to the auth + age-gate block below, so a signed-in visitor is gated exactly
  // as before (no age record → /complete-profile, under 18 → /access-denied).
  // The only branch that changes for them is the "no session → /sign-in" one,
  // which the fall-through below relaxes to "let them read the lobby".
  //
  // Enforcement is not weakened: the matchmaking APIs authenticate and
  // age-gate independently (`requireAgeVerifiedUser`), so this relaxes the page
  // read only — a signed-out visitor can look at a lobby but can start nothing.
  // Opening AI practice to guests is a separate change on those API routes.
  if (isPublicRoute(req) && !isGameRoute(pathname)) {
    // User-level MFA runs even on public pages (casino pages are public
    // routes but wagering on them must stay protected). auth() here is the
    // same call protected routes already make.
    const mfaGate = await userMfaGate(req, pathname, auth);
    if (mfaGate) return mfaGate;
    
    // Admin MFA setup endpoints that expose sensitive secrets (TOTP seed)
    // must require completed MFA. The initial MFA flow (send-otp, verify,
    // status) remains accessible without MFA so admins can complete their
    // first factor, but TOTP enrollment requires an existing MFA session.
    if (pathname === "/api/admin/mfa/setup-totp") {
      const { userId, factorVerificationAge } = await auth();
      if (!userId) {
        return applySecurityHeaders(
          NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
        );
      }
      if (!(await edgeIsAdmin(userId))) {
        return applySecurityHeaders(
          NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 })
        );
      }
      
      const adminMfaToken = req.cookies.get(ADMIN_MFA_COOKIE)?.value;
      const userMfaToken = req.cookies.get(USER_MFA_COOKIE)?.value;
      if (
        !hasRecentMfa(factorVerificationAge) &&
        !(await verifyAdminMfaToken(adminMfaToken, userId)) &&
        !(await verifyUserMfaToken(userMfaToken, userId))
      ) {
        auditLog("admin_mfa_required", { userId, ip: getClientIp(req), path: pathname });
        return applySecurityHeaders(
          NextResponse.json(
            { success: false, error: "MFA required. Complete email verification first." },
            { status: 403 }
          )
        );
      }
    }
    
    return applySecurityHeaders(NextResponse.next());
  }

  const { userId, sessionClaims, factorVerificationAge } = await auth();

  // A game route may be READ while signed out — that is the whole point of a
  // public lobby. This relaxes the PAGE gate only: the matchmaking APIs
  // authenticate and age-gate on their own, so nothing can be played from here.
  const browsingGameSignedOut = !userId && isGameRoute(pathname);

  if (!userId && !browsingGameSignedOut) {
    auditLog("auth_required_redirect", { ip, path: pathname });
    return applySecurityHeaders(NextResponse.redirect(new URL("/sign-in", req.url)));
  }

  // ONLY enforce age on protected app routes, NOT on /sync, onboarding,
  // or the admin dashboard. /admin stays authenticated here and is DB-admin
  // gated by src/app/admin/page.tsx before the dashboard can render.
  const skipsAgeGate =
    pathname.startsWith("/sync") ||
    pathname.startsWith("/complete-profile") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/api/admin");

  // Signed-out visitors on a game route have no session to age-check, and the
  // age gate is about what a session may DO; there is nothing to gate, since
  // every play path below still requires one. So it applies to signed-in users
  // only — exactly as before for them.
  if (userId && !skipsAgeGate) {
    // Prefer the session claim when a JWT template provides one. When it
    // does, the age gate costs zero DB work per request.
    let age = sessionClaims?.age;

    if (age === undefined || age === null) {
      // Fall back to a cached `users.age` lookup so a protected page load
      // doesn't hit the DB on every navigation. Age only changes on a
      // birthdate edit (rare), so a short TTL is plenty. When Redis/KV is
      // not configured, cacheGet/cacheSet no-op and we do the DB read once
      // per request, exactly as before. A slow/hung DB must never block
      // the page (fail open = treat as "age unknown", which redirects to
      // /complete-profile rather than hanging the browser).
      age = await cacheGet<number | null>(CacheKeys.userAge(userId));
      if (age === null || age === undefined) {
        age = await withTimeout(edgeUserAge(userId), 1500, null);
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
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    const adminIds = (process.env.CHAT_ADMIN_CLERK_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);

    if (adminIds.length > 0 && adminIds.includes(userId)) {
      // Fast path: user is in env var allowlist — let through immediately.
    } else {
      // DB-backed check — the source of truth for admin badges.
      const admin = await edgeIsAdmin(userId);
      if (!admin) {
        auditLog("admin_access_blocked", {
          userId,
          ip,
          path: pathname,
        });
        if (pathname.startsWith("/api/admin")) {
          return applySecurityHeaders(
            NextResponse.json(
              { success: false, error: "Admin access required." },
              { status: 403 }
            )
          );
        }
        return applySecurityHeaders(
          NextResponse.redirect(new URL("/", req.url))
        );
      }
    }
  }

  // MFA enforcement for admin UI routes (defense in depth — the admin
  // page component re-checks the same condition). The session must have
  // verified a second factor recently; anything else fails closed.
  // `/admin/mfa-required` itself is exempt so the gate page can render.
  // Note: /api/admin paths are handled earlier (before the public-route
  // branch) and never reach this point.
  if (pathname.startsWith("/admin") && pathname !== "/admin/mfa-required") {
    const adminMfaToken = req.cookies.get(ADMIN_MFA_COOKIE)?.value;
    const userMfaToken = req.cookies.get(USER_MFA_COOKIE)?.value;
    if (
      !hasRecentMfa(factorVerificationAge) &&
      !(await verifyAdminMfaToken(adminMfaToken, userId)) &&
      !(await verifyUserMfaToken(userMfaToken, userId))
    ) {
      auditLog("admin_mfa_required_redirect", { userId, ip, path: pathname });
      return applySecurityHeaders(
        NextResponse.redirect(new URL("/admin/mfa-required", req.url))
      );
    }
  }

  // User-level MFA gate for protected app routes (reuses the auth result
  // fetched above — no second auth() call).
  const mfaGate = await userMfaGate(req, pathname, auth, {
    userId,
    factorVerificationAge,
  });
  if (mfaGate) return mfaGate;

  return applySecurityHeaders(NextResponse.next());
};

const clerkProtectedMiddleware = clerkMiddleware(middlewareHandler);
const hasClerkSecretKey = Boolean(process.env.CLERK_SECRET_KEY);

// Next.js 16 renamed the `middleware` convention to `proxy`, and the two are
// NOT equivalent — see `build/entries.js`:
//   - `proxy.ts`      is dispatched to the Node.js server UNCONDITIONALLY
//   - `middleware.ts` runs on the EDGE server, unless it declares
//                     `runtime = "nodejs"`
// Cloudflare's OpenNext adapter does not support Node.js middleware, so this
// file deliberately keeps the `middleware` (Edge) convention.
//
// It therefore MUST NOT import `pg`/`db`. The four DB-backed gates — the
// maintenance flag, the admin badge, `age`, and `mfa_enabled` — read through
// src/lib/security/edgeFlags.ts, which uses PostgREST over `fetch`
// (Edge-safe). Every other dependency here was already Edge-safe: the MFA
// cookies are Web Crypto (src/lib/auth/adminMfa.ts), rate limiting is
// fetch/in-memory, and the cache is Upstash over HTTP.
/**
 * Stamp the visitor's country onto page responses.
 *
 * The consent prompt is chosen on the client (components/ConsentRegionGate.tsx)
 * because reading the request headers — or exporting `force-dynamic` — in the
 * root layout made EVERY route render on each request. On Cloudflare Workers a
 * request gets 10 ms of CPU and a measured page render needed 38-937 ms, so
 * 5-20% of page loads were killed with error 1102 (exceededCpu). A cookie is the
 * one way to hand the country to the browser on the SAME response that carries
 * the HTML: the browser applies `Set-Cookie` before any script runs, so even the
 * first page view knows its region.
 *
 * Deliberately skipped for `/api/*` (no consent UI renders there) and once the
 * value is unchanged, so a session costs one extra header, not one per request.
 * `httpOnly` must stay false — this cookie is read from JavaScript.
 */
function withCountryCookie(
  res: NextResponse | Response | void,
  req: NextRequest,
): NextResponse | Response | void {
  // clerkMiddleware may pass through (void) or return a bare Response; only a
  // NextResponse can carry a Set-Cookie through its cookie API, so anything else
  // is returned untouched.
  if (!(res instanceof NextResponse)) return res;
  if (req.nextUrl.pathname.startsWith("/api/")) return res;

  const country = countryFromHeaders(req.headers);
  // No geo header (local `next dev`): leave the cookie absent. The client treats
  // that as "not the EEA", i.e. our banner — exactly as before this change.
  if (!country) return res;
  if (req.cookies.get(COUNTRY_COOKIE)?.value === country) return res;

  res.cookies.set(COUNTRY_COOKIE, country, {
    path: "/",
    maxAge: 60 * 60,
    sameSite: "lax",
    httpOnly: false,
    secure: true,
  });
  return res;
}

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  if (!hasClerkSecretKey) {
    return withCountryCookie(applySecurityHeaders(NextResponse.next()), req);
  }

  try {
    return withCountryCookie(await clerkProtectedMiddleware(req, event), req);
  } catch (error) {
    console.error(
      "[middleware] Clerk middleware invocation failed; returning safe response.",
      error
    );
    return withCountryCookie(applySecurityHeaders(NextResponse.next()), req);
  }
}

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
