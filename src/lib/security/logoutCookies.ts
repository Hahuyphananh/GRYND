// src/lib/security/logoutCookies.ts
// Logout hygiene: every cookie that must not survive a sign-out, and the
// deletion applied to a cookie jar. Kept free of `next/*` imports so the
// exact deletion behavior is unit-testable outside a Next.js runtime (see
// tests/session-cleanup.test.mjs); src/app/api/auth/clear-session/route.ts
// is a thin shell around this.

import { ADMIN_MFA_COOKIE } from "../auth/adminMfa";

export const LOGOUT_COOKIES = [
  // Self-hosted admin second-factor marker (24h, HttpOnly, bound to
  // userId but NOT to the Clerk session — must be wiped on logout so a
  // re-login on the same device cannot bypass MFA).
  ADMIN_MFA_COOKIE,
  // Clerk session/client cookies — normally cleared by Clerk's signOut(),
  // cleared here too so the delete-account fallback path (where signOut
  // can fail) leaves the device fully clean.
  "__session",
  "__client",
  "__client_uat",
  "__clerk_db_jwt",
  "__clerk_fingerprint",
  // Never set by the app today, but cleared defensively.
  "csrf_token",
] as const;

export function logoutCookieClearOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}

/** Cookie-jar interface satisfied by Next's `cookies()` store. */
export interface LogoutCookieJar {
  set(name: string, value: string, options: ReturnType<typeof logoutCookieClearOptions>): void;
}

/**
 * Expires every logout-sensitive cookie on the given jar (maxAge 0 =
 * immediate deletion). Idempotent — clearing a cookie that is absent is a
 * no-op.
 */
export function applyLogoutCookieDeletions(jar: LogoutCookieJar): void {
  const options = logoutCookieClearOptions();
  for (const name of LOGOUT_COOKIES) {
    jar.set(name, "", options);
  }
}
