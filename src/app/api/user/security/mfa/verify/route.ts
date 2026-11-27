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
  issueUserMfaToken,
  mfaCookieOptions,
  USER_MFA_MAX_AGE_SECONDS,
} from "../../../../../../lib/auth/adminMfa";
import { cacheDelete } from "../../../../../../lib/redis/cache";
import { CacheKeys } from "../../../../../../lib/redis/keys";
import { auditLog } from "../../../../../../lib/security/auditLog";
import { clientIpFromHeaders } from "../../../../../../lib/security/clientIp";
import {
  checkVerifyAttemptLimit,
  recordVerifyFailure,
  clearVerifyAttempts,
} from "../../../../../../lib/security/mfaAttemptLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const ip = clientIpFromHeaders(req.headers);

  // Durable attempt limit. The generic API limiter (60/min per user) resets
  // every window, so without this a six-digit factor could be guessed
  // indefinitely. Same thresholds as the admin gate, separate key namespace.
  const attemptCheck = await checkVerifyAttemptLimit(userId, "user");
  if (!attemptCheck.allowed) {
    const lockedUntil = attemptCheck.lockedUntil ?? Date.now();
    const remainingMinutes = Math.ceil(Math.max(0, lockedUntil - Date.now()) / 60_000);
    auditLog("user_mfa_verify_locked", { userId, ip, attempts: attemptCheck.attempts });
    return NextResponse.json(
      {
        success: false,
        error: `Too many failed attempts. Please try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}.`,
      },
      { status: 429 },
    );
  }

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!(await verifyOtp(userId, code))) {
    await recordVerifyFailure(userId, "user");
    auditLog("user_mfa_verify_failed", { userId, ip });
    return NextResponse.json(
      { success: false, error: "Invalid code. Please try again." },
      { status: 401 },
    );
  }

  await clearVerifyAttempts(userId, "user");

  await db
    .update(users)
    .set({ mfaEnabled: true })
    .where(eq(users.clerkId, userId));

  // Invalidate the middleware's cached flag so the gate kicks in immediately.
  await cacheDelete(CacheKeys.userMfa(userId)).catch(() => {});

  auditLog("user_mfa_enabled", { userId, ip });

  const res = NextResponse.json({ success: true, mfaEnabled: true });
  res.cookies.set(
    USER_MFA_COOKIE,
    await issueUserMfaToken(userId),
    mfaCookieOptions(req, USER_MFA_MAX_AGE_SECONDS),
  );
  return res;
}