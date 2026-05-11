import { renderTemplate, sendEmailSafely } from "./base";
export async function sendInactivityEmail(user: {
  clerkId: string;
  email: string;
}) {
  return sendEmailSafely({
    user,
    type: "inactivity_reactivation",
    dedupeKey: `inactive:${user.clerkId}`,
    subject: "We miss you at GoonBet",
    html: renderTemplate(
      "We miss you",
      `<p>Come back now for a comeback reward: <b>50 bonus tokens</b>.</p><p>Offer ends soon.</p>`,
      "Return to Casino",
      `${process.env.NEXT_PUBLIC_APP_URL ?? "https://goonbet.dedyn.io"}`,
    ),
  });
}
