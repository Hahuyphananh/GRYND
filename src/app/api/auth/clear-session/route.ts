// src/app/api/auth/clear-session/route.ts
// Logout hygiene endpoint: clears every cookie that must not survive a
// sign-out. Clerk's own signOut() already revokes the session and clears
// its cookies, but this endpoint is the fallback that also runs when the
// Clerk session is already invalid (e.g. right after account deletion) —
// and it is the only way to clear the HttpOnly `admin_mfa` cookie, which
// document.cookie cannot touch.
//
// No auth is required on purpose: clearing cookies grants nothing, and the
// delete-account flow calls this after the Clerk session is already gone.
// The middleware still applies same-origin CSRF protection and rate limits.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { applyLogoutCookieDeletions } from "../../../../lib/security/logoutCookies";

export async function POST() {
  const jar = await cookies();
  applyLogoutCookieDeletions(jar);
  return NextResponse.json({ success: true });
}
