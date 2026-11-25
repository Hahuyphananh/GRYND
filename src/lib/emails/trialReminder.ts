// src/lib/emails/trialReminder.ts
//
// THE TRIAL-ENDING REMINDER — the email the paywall promises when a member
// picks "remind me N days before".
//
// Billing mail is TRANSACTIONAL: it is not gated by notification preferences
// and carries no marketing footer, because telling someone when their card is
// about to be charged is a payment notice, not a promotion. It is deduped per
// Stripe subscription, so a daily sweep can never send it twice.

import { escapeHtml, renderTemplate, sendEmailSafely } from "./base";
import { getSiteUrl } from "../siteUrl";

/** `email_events.type` for the reminder (also the analytics label). */
export const PRO_TRIAL_REMINDER_TYPE = "pro_trial_reminder";

/**
 * The reminder body. `chargeDate` is a plain formatted day and `interval` a
 * billing cadence; both are operator-controlled, but they are escaped anyway —
 * email HTML is not a place to trust interpolation.
 */
export function buildProTrialReminderHtml({
  name,
  chargeDate,
  interval,
}: {
  name?: string | null;
  chargeDate: string;
  interval: string;
}): string {
  const player = escapeHtml(String(name ?? "").trim() || "Player");
  const date = escapeHtml(chargeDate);
  const cadence = escapeHtml(interval);

  return renderTemplate(
    "Your GRYND PRO trial ends soon",
    `<p>Hey ${player},</p>` +
      `<p>Your GRYND PRO trial ends on <strong>${date}</strong>. That is the day your ` +
      `${cadence} membership starts and Stripe charges the price you agreed to at checkout.</p>` +
      `<p>If PRO isn't for you, cancel before ${date} from Manage subscription and you ` +
      `pay nothing. Everything that is free today stays free either way.</p>`,
    "Manage subscription",
    `${getSiteUrl()}/upgrade-pro`,
  );
}

/**
 * Send one reminder through the shared pipeline. `dedupeKey` is the Stripe
 * subscription id, so a re-run of the sweep is a no-op for an already-notified
 * member.
 */
export async function sendProTrialReminder({
  clerkId,
  email,
  name,
  chargeDate,
  interval,
  subscriptionId,
}: {
  clerkId: string;
  email: string;
  name?: string | null;
  chargeDate: string;
  interval: string;
  subscriptionId: string;
}) {
  return sendEmailSafely({
    user: { clerkId, email, name: name ?? undefined },
    type: PRO_TRIAL_REMINDER_TYPE,
    category: "transactional",
    dedupeKey: `pro-trial-reminder:${subscriptionId}`,
    subject: `Your GRYND PRO trial ends on ${chargeDate}`,
    html: buildProTrialReminderHtml({ name, chargeDate, interval }),
  });
}
