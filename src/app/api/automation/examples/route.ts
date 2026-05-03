import { NextResponse } from "next/server";
import { sendDepositProcessingEmail, sendDepositSuccessEmail, sendWithdrawalRequestedEmail } from "../../../../lib/emails/payments";
import { sendLossStreakEmail, sendBigWinEmail } from "../../../../lib/emails/behavior";
import { sendLoginAlertEmail } from "../../../../lib/emails/security";

export async function POST() {
  const user = { clerkId: "demo_clerk", email: "demo@example.com", username: "demo" };
  await sendDepositProcessingEmail(user, 100);
  await sendDepositSuccessEmail(user, 100);
  await sendWithdrawalRequestedEmail(user, 30);
  await sendLossStreakEmail(user);
  await sendBigWinEmail(user, 900);
  await sendLoginAlertEmail(user, "Chrome on macOS", "New York, US");
  return NextResponse.json({ ok: true });
}
