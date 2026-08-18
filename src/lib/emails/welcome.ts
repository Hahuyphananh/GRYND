import { escapeHtml, renderTemplate, sendEmailSafely } from "./base";

// Tabler-style slot machine icon, inlined as SVG since email clients
// don't run the app's icon components.
const SLOT_MACHINE_ICON = `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 14px" aria-hidden="true"><rect x="3" y="4" width="14" height="17" rx="2"/><rect x="5.5" y="6.5" width="9" height="5" rx="1"/><path d="M8 9h.01M10.5 9h.01M13 9h.01"/><path d="M6.5 15.5h7"/><circle cx="9" cy="18" r="0.9"/><circle cx="11.5" cy="18" r="0.9"/><path d="M17 12.5l3-1.2"/><circle cx="20.6" cy="10.9" r="1.1"/></svg>`;

export async function sendWelcomeEmail(user: {
  clerkId: string;
  email: string;
  username?: string;
}) {
  return sendEmailSafely({
    user,
    type: "welcome",
    dedupeKey: `welcome:${user.clerkId}`,
    subject: "Welcome to GoonBet",
    html: renderTemplate(
      "Welcome to GoonBet",
      `${SLOT_MACHINE_ICON}<p>Hey ${escapeHtml(user.username ?? "Player")}, your account is live and your casino wallet is ready.</p>`,
      "Start Playing",
      `${process.env.NEXT_PUBLIC_APP_URL ?? "https://goonbet.dedyn.io"}`,
    ),
  });
}
