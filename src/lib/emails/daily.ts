import { renderTemplate, sendEmailSafely } from "./base";
export async function sendDailyRewardEmail(
  user: { clerkId: string; email: string; username?: string },
  rewardAmount = 25,
) {
  return sendEmailSafely({
    user,
    type: "daily_reward",
    dedupeKey: `daily:${user.clerkId}:${new Date().toISOString().slice(0, 10)}`,
    subject: "Your daily bonus is ready",
    html: renderTemplate(
      "Daily Bonus Ready",
      `<p>${user.username ?? "Player"}, claim your <b>${rewardAmount} tokens</b> now.</p>`,
      "Claim Tokens",
      `${process.env.NEXT_PUBLIC_APP_URL ?? "https://goonbet.dedyn.io"}/daily`,
    ),
  });
}
