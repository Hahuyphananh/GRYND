// POST /api/user/security/mfa/send — email a 6-digit one-time code to the
// authenticated user's address so they can enable (or re-verify) the
// self-hosted email-OTP second factor. Same mechanism as the admin MFA gate.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { users } from "../../../../../../db/schema";
import { issueOtp } from "../../../../../../lib/auth/adminOtp";
import { sendEmailSafely } from "../../../../../../lib/emails/base";
import { auditLog } from "../../../../../../lib/security/auditLog";
import { clientIpFromHeaders } from "../../../../../../lib/security/clientIp";
import {
  checkSendAttemptLimit,
  recordSendAttempt,
} from "../../../../../../lib/security/mfaAttemptLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const ip = clientIpFromHeaders(req.headers);

    // Per-user send budget (3 per 5 minutes). Without it every "send" button
    // press is an email to the account holder — an easy way to flood a
    // victim's inbox using their own session, or to burn the provider quota.
    const sendCheck = await checkSendAttemptLimit(userId, "user");
    if (!sendCheck.allowed) {
      const resetAt = sendCheck.resetAt ?? Date.now();
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      auditLog("user_mfa_code_send_limited", { userId, ip, retryAfterSeconds });
      return NextResponse.json(
        {
          success: false,
          error: "Too many codes requested. Please wait a few minutes and try again.",
          retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    const email = row?.email;
    if (!email) {
      return NextResponse.json(
        { success: false, error: "No email address is on file for your account." },
        { status: 400 },
      );
    }

    await recordSendAttempt(userId, "user");

    const code = await issueOtp(userId);
    const result = await sendEmailSafely({
      user: { email, clerkId: userId },
      subject: "Your GRYND verification code",
      html: `
        <p>A one-time verification code was requested for your GRYND account.</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#fbbf24;margin:16px 0">${code}</p>
        <p>This code expires in 5 minutes. If you didn't request it, you can ignore this email.</p>
      `,
      type: "user_mfa_otp",
      category: "security",
    });

    if (result.sent !== true) {
      console.error(
        "[user/security/mfa/send] Failed to send code:",
        result?.reason ?? "send failed",
        result?.details ?? "",
      );
      return NextResponse.json(
        { success: false, error: "Failed to send the code. Please try again." },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, expiresInSeconds: 300 });
  } catch (err) {
    console.error("[user/security/mfa/send] Unexpected error:", (err as Error).message);
    return NextResponse.json(
      { success: false, error: "Failed to send the code. Please try again." },
      { status: 500 },
    );
  }
}