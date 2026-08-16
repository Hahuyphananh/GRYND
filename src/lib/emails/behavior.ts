import { renderTemplate, sendEmailSafely } from "./base";

// Tabler-style confetti icon (same SVG as the in-app IconConfetti),
// inlined as SVG since email clients don't run the app's icon components.
const CONFETTI_ICON = `<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto 14px" aria-hidden="true"><path d="M4 5h2"/><path d="M5 4v2"/><path d="M11.5 4l-.5 2"/><path d="M18 5h2"/><path d="M19 4v2"/><path d="M15 9l-1 1"/><path d="M18 13l2 -.5"/><path d="M18 19h2"/><path d="M19 18v2"/><path d="M14 16.518l-6.518 -6.518l-4.39 9.58a1 1 0 0 0 1.329 1.329l9.579 -4.39"/></svg>`;

export const sendLossStreakEmail = (user: any) =>
  sendEmailSafely({
    user,
    type: "loss_streak",
    subject: "Comeback reward unlocked",
    html: renderTemplate(
      "Tough streak?",
      "<p>You lost 3 in a row. Here are bonus tokens for your comeback.</p>",
    ),
  });
export const sendBigWinEmail = (user: any, amount: number) =>
  sendEmailSafely({
    user,
    type: "big_win",
    category: "transactional",
    subject: "Huge win!",
    html: renderTemplate(
      "Big Win",
      `${CONFETTI_ICON}<p>You just won <b>${amount}</b> tokens. VIP perks may be waiting.</p>`,
    ),
  });
export const sendFraudAlertEmail = (user: any, reason: string) =>
  sendEmailSafely({
    user,
    type: "fraud_alert",
    category: "security",
    subject: "Account warning notice",
    html: renderTemplate(
      "Potential abuse detected",
      `<p>Reason: ${reason}</p><p>Your account may be restricted pending review.</p>`,
    ),
  });
