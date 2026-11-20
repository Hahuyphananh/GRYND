// src/app/api/jobs/pro-trial-reminders/route.ts
//
// GET /api/jobs/pro-trial-reminders — the daily pass that actually sends the
// reminder a member picked on the paywall.
//
// WHY THIS EXISTS
// ---------------
// The trial timeline tells a buyer: "pick a reminder and we'll email you before
// you're charged". A promise like that is worth nothing if nothing sends it, so
// this job closes the loop:
//
//   * it reads Stripe subscriptions in `trialing` (the source of truth for the
//     trial — entitlement already comes from the same status),
//   * each subscription carries `metadata.trialReminderDays` (written by
//     /api/stripe/subscribe from the member's choice) and `trial_end`,
//   * when the trial ends within that many days, the member gets one billing
//     email with the exact date; `dedupeKey` makes repeated runs idempotent,
//   * `0` means "no reminder", and it is honoured: nothing is sent.
//
// READ SCOPE: it reads subscriptions and users, writes only the shared email
// log. It never changes a subscription, a charge or an entitlement.

import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { getStripe } from "../../../../lib/stripe";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";
import {
  DEFAULT_PRO_TRIAL_REMINDER_DAYS,
  isProTrialReminderDays,
} from "../../../../lib/proTrial";
import { sendProTrialReminder } from "../../../../lib/emails/trialReminder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stripe's recurring interval → the wording the email uses. */
function intervalLabel(interval: string | undefined): string {
  if (interval === "year") return "yearly";
  if (interval === "week") return "weekly";
  return "monthly";
}

export async function GET(request: Request) {
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  try {
    const stripe = getStripe();
    const now = Date.now();

    // Trialing subscriptions only. The cap keeps one invocation bounded; at
    // this stage of the product it is well above the real count, and the pass
    // runs daily, so anything beyond it is picked up the next day.
    const subscriptions = await stripe.subscriptions.list({
      status: "trialing",
      limit: 100,
    });

    let checked = 0;
    let sent = 0;
    let skipped = 0;

    for (const subscription of subscriptions.data) {
      checked += 1;

      const clerkId = subscription.metadata?.clerkId;
      const trialEnd = subscription.trial_end;
      if (!clerkId || !trialEnd) {
        skipped += 1;
        continue;
      }

      const rawReminder = Number(subscription.metadata?.trialReminderDays);
      const reminderDays = isProTrialReminderDays(rawReminder)
        ? rawReminder
        : DEFAULT_PRO_TRIAL_REMINDER_DAYS;

      // "No reminder" is an explicit choice — never email this member.
      if (reminderDays === 0) {
        skipped += 1;
        continue;
      }

      const daysLeft = (trialEnd * 1000 - now) / DAY_MS;
      if (daysLeft > reminderDays) {
        skipped += 1;
        continue;
      }

      const [user] = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);
      if (!user?.email) {
        skipped += 1;
        continue;
      }

      const result = await sendProTrialReminder({
        clerkId,
        email: user.email,
        name: user.name,
        chargeDate: new Date(trialEnd * 1000).toISOString().slice(0, 10),
        interval: intervalLabel(subscription.items?.data?.[0]?.price?.recurring?.interval),
        subscriptionId: subscription.id,
      });

      if ("skipped" in result && result.skipped) skipped += 1;
      else sent += 1;
    }

    return Response.json({ success: true, checked, sent, skipped });
  } catch (error) {
    console.error("[jobs/pro-trial-reminders] sweep failed:", error);
    return Response.json(
      { success: false, error: "Trial reminder sweep failed" },
      { status: 500 },
    );
  }
}
