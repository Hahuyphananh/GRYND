import { renderTemplate, sendEmailSafely } from "./base";
export async function sendWeeklySummaryEmail(
  user: { clerkId: string; email: string },
  stats: {
    totalWins: number;
    totalLosses: number;
    net: number;
    periodKey: string;
  },
) {
  const msg =
    stats.net >= 0
      ? `You won ${stats.net} tokens this week.`
      : `You're ${Math.abs(stats.net)} tokens down this week.`;
  return sendEmailSafely({
    user,
    type: "weekly_summary",
    dedupeKey: `summary:${user.clerkId}:${stats.periodKey}`,
    subject: "Your weekly game summary",
    html: renderTemplate(
      "Weekly Summary",
      `<p>Total wins: ${stats.totalWins}</p><p>Total losses: ${stats.totalLosses}</p><p><b>${msg}</b></p>`,
    ),
  });
}
