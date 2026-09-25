import { renderTemplate, sendEmailSafely } from "./base";

export const sendLossStreakEmail = (user: any) =>
  sendEmailSafely({
    user,
    type: "loss_streak",
    subject: "Comeback reward unlocked",
    html: renderTemplate(
      "Tough streak?",
      "<p>You lost 3 in a row. Reset, regroup, and climb back up the Battle Pass.</p>",
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
