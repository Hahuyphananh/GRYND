import { renderTemplate, sendEmailSafely } from "./base";
import { getSiteUrl } from "../siteUrl";
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
      `<p>Come back and pick up where you left off — your ladder position is waiting.</p>`,
      "Return to Games",
      getSiteUrl(),
    ),
  });
}
