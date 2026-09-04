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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
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

  if (!result.sent) {
    console.error(
      "[user/security/mfa/send] Failed to send code:",
      result?.skipped ? result?.reason || "skipped" : "send failed",
    );
    return NextResponse.json(
      { success: false, error: "Failed to send the code. Please try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, expiresInSeconds: 300 });
}