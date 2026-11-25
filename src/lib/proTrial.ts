// src/lib/proTrial.ts
//
// THE FREE TRIAL — one set of numbers shared by the paywall and the checkout.
//
// The paywall promises three things in its trial timeline: you try PRO free,
// you pick a reminder, and you see the day you are charged. All three must be
// TRUE, so the trial length and the reminder options live here, in a module
// with no server imports:
//
//   * the checkout route reads `PRO_TRIAL_DAYS` and puts it on the Stripe
//     subscription as a real `trial_period_days`, so the first charge genuinely
//     happens after the trial,
//   * the timeline renders the same number and computes the same charge date,
//   * the reminder the member picks is carried on the subscription metadata and
//     sent by the daily `/api/jobs/pro-trial-reminders` pass.
//
// Nothing here decides entitlement: Stripe reports `trialing`, and
// ACTIVE_SUBSCRIPTION_STATUSES in lib/stripe/subscriptions.ts already treats
// that as an active membership.

/** How long a new GRYND PRO subscription is free for. */
export const PRO_TRIAL_DAYS = 7;

/**
 * The reminder choices offered on the paywall, in display order: how many days
 * BEFORE the first charge the member wants to hear from us. `0` means "no
 * reminder" — still a real choice, and it is honoured by the reminder pass.
 */
export const PRO_TRIAL_REMINDER_DAYS = [3, 1, 0] as const;

export type ProTrialReminderDays = (typeof PRO_TRIAL_REMINDER_DAYS)[number];

/** Preselected option: enough notice to decide, not so early it gets ignored. */
export const DEFAULT_PRO_TRIAL_REMINDER_DAYS: ProTrialReminderDays = 3;

/** Is this a reminder choice the paywall offers (and the server may store)? */
export function isProTrialReminderDays(value: unknown): value is ProTrialReminderDays {
  return (
    typeof value === "number" &&
    (PRO_TRIAL_REMINDER_DAYS as readonly number[]).includes(value)
  );
}

/**
 * The UTC day the first charge lands on, `PRO_TRIAL_DAYS` after `from`.
 *
 * Stripe sets `trial_period_days` on its own clock from checkout completion, so
 * this is the promise shown before checkout, not the authoritative instant. The
 * reminder email uses the subscription's actual `trial_end` instead.
 */
export function trialChargeDate(from: Date = new Date()): Date {
  const date = new Date(from.getTime());
  date.setUTCDate(date.getUTCDate() + PRO_TRIAL_DAYS);
  return date;
}
