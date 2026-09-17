// src/app/api/admin/mfa/send-otp/route.ts
// POST — email a 6-digit one-time code to the authenticated admin's address.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { users } from "../../../../../db/schema";
import { isAdmin } from "../../../../../lib/auth/isAdmin";
import { issueOtp } from "../../../../../lib/auth/adminOtp";
import { sendEmailSafely } from "../../../../../lib/emails/base";
import {
  checkSendAttemptLimit,
  recordSendAttempt,
} from "../../../../../lib/security/mfaAttemptLimit";

export const runtime = "nodejs";

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!(await isAdmin(userId))) {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    // Check OTP send rate limit before generating and sending
    const sendCheck = await checkSendAttemptLimit(userId);
    if (!sendCheck.allowed) {
      const resetAt = sendCheck.resetAt ?? Date.now();
      const remainingMs = Math.max(0, resetAt - Date.now());
      const remainingMinutes = Math.ceil(remainingMs / 60_000);
      
      return NextResponse.json(
        {
          success: false,
          error: `Too many OTP requests. Please try again in ${remainingMinutes} minute${remainingMinutes !== 1 ? "s" : ""}.`,
        },
        { status: 429 },
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

    // Record the send attempt before generating the OTP
    await recordSendAttempt(userId);

    const code = await issueOtp(userId);
    const result = await sendEmailSafely({
      user: { email, clerkId: userId },
      subject: "Your GRYND admin verification code",
      html: `
        <p>A one-time verification code was requested for admin access on GRYND.</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:#fbbf24;margin:16px 0">${code}</p>
        <p>This code expires in 5 minutes. If you didn't request it, you can ignore this email.</p>
      `,
      type: "admin_mfa_otp",
      category: "security",
    });

    if (result.sent !== true) {
      // Reason + details only — never log the send result object wholesale in
      // case a provider payload echoes the recipient address.
      console.error(
        "[admin/mfa/send-otp] Failed to send code:",
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
    console.error("[admin/mfa/send-otp] Unexpected error:", (err as Error).message);
    return NextResponse.json(
      { success: false, error: "Failed to send the code. Please try again." },
      { status: 500 },
    );
  }
}
