import { renderTemplate, sendEmailSafely } from "./base";
export async function sendWelcomeEmail(user: { clerkId: string; email: string; username?: string }) {
  return sendEmailSafely({ user, type: "welcome", dedupeKey: `welcome:${user.clerkId}`, subject: "Welcome to GoonBet 🎰", html: renderTemplate("Welcome to GoonBet", `<p>Hey ${user.username ?? "Player"}, your account is live and your casino wallet is ready.</p>`, "Start Playing", `${process.env.NEXT_PUBLIC_APP_URL ?? "https://goonbet.dedyn.io"}`) });
}
