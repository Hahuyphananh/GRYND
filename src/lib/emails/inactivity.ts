import { renderTemplate, sendEmailSafely } from "./base";
export async function sendInactivityEmail(user: {
  clerkId: string;
  email: string;
}) {
  return sendEmailSafely({
    user,
    type: "inactivity_reactivation",
    dedupeKey: `inactive:${user.clerkId}`,
    subject: "We miss you at GRYND",
    html: renderTemplate(
      "We miss you",
      `<p>Come back and pick up where you left off — daily XP and new Battle Pass rewards are waiting.</p>`,
      "Return to Games",
      `${process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://www.grynd.dedyn.io"}`,
    ),
  });
}
