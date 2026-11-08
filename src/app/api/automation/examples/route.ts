import { NextResponse } from "next/server";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";
import {
  sendDepositProcessingEmail,
  sendDepositSuccessEmail,
  sendWithdrawalRequestedEmail,
} from "../../../../lib/emails/payments";
import { sendLossStreakEmail } from "../../../../lib/emails/behavior";
import { sendLoginAlertEmail } from "../../../../lib/emails/security";

// Sends five real emails per call, so it is authenticated like the other
// jobs. Left open, anyone could use it to mail the configured From address.
export async function POST(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const user = {
    clerkId: "demo_clerk",
    email: "demo@example.com",
    username: "demo",
  };
  await sendDepositProcessingEmail(user, 100);
  await sendDepositSuccessEmail(user, 100);
  await sendWithdrawalRequestedEmail(user, 30);
  await sendLossStreakEmail(user);
  await sendLoginAlertEmail(user, "Chrome on macOS", "New York, US");
  return NextResponse.json({ ok: true });
}
