// POST /api/user/security/mfa/verify — verify the emailed OTP, enable the
// user's second factor, and issue the signed 24h user-MFA cookie so the
// current session (and the 24h window) is satisfied immediately.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { users } from "../../../../../../db/schema";
import { verifyOtp } from "../../../../../../lib/auth/adminOtp";
import {
  USER_MFA_COOKIE,
  USER_MFA_MAX_AGE_SECONDS,
  issueUserMfaToken,
} from "../../../../../../lib/auth/adminMfa";
import { cacheDelete } from "../../../../../../lib/redis/cache";
import { CacheKeys } from "../../../../../../lib/redis/keys";
import { auditLog } from "../../../../../../lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!(await verifyOtp(userId, code))) {
    auditLog("user_mfa_verify_failed", { userId, ip: null });
    return NextResponse.json(
      { success: false, error: "Invalid code. Please try again." },
      { status: 401 },
    );
  }

  await db
    .update(users)
    .set({ mfaEnabled: true })
    .where(eq(users.clerkId, userId));

  // Invalidate the middleware's cached flag so the gate kicks in immediately.
  await cacheDelete(CacheKeys.userMfa(userId)).catch(() => {});

  auditLog("user_mfa_enabled", { userId, ip: null });

  const res = NextResponse.json({ success: true, mfaEnabled: true });
  res.cookies.set(USER_MFA_COOKIE, await issueUserMfaToken(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: USER_MFA_MAX_AGE_SECONDS,
  });
  return res;
}