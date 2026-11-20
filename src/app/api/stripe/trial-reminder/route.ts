// src/app/api/stripe/trial-reminder/route.ts
//
// GET/PUT — the trial reminder a member picked at checkout, for the upgrade
// page while the trial is running.
//
//   GET → { trialing: false } when the caller is not in a trial, otherwise the
//         authoritative trial end and the reminder currently stored on the
//         Stripe subscription.
//   PUT { reminderDays } → move or turn off that reminder.
//
// OWNERSHIP: the subscription id comes from the caller's OWN row
// (`findTrialingSubscription`), never from the request body, so one user cannot
// edit another's reminder. Only metadata is written — no amount, price, status,
// period or entitlement is touched.
//
// NO EXTRA STATE: the reminder lives on the Stripe subscription
// (`metadata.trialReminderDays`), the same field the daily
// `/api/jobs/pro-trial-reminders` pass reads. There is nothing to keep in sync.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getStripe } from "../../../../lib/stripe";
import { findTrialingSubscription } from "../../../../lib/stripe/subscriptions";
import {
  DEFAULT_PRO_TRIAL_REMINDER_DAYS,
  isProTrialReminderDays,
} from "../../../../lib/proTrial";
import { auditLog } from "../../../../lib/security/auditLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The ISO instant of the first charge, or null when Stripe has no trial end. */
function trialEndsAt(trialEnd: number | null | undefined): string | null {
  return trialEnd ? new Date(trialEnd * 1000).toISOString() : null;
}

/** The caller's trialing Stripe subscription, or null. */
async function loadOwnTrial(clerkId: string) {
  const row = await findTrialingSubscription(clerkId);
  if (!row) return null;
  const subscription = await getStripe().subscriptions.retrieve(
    row.stripeSubscriptionId,
  );
  return subscription;
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const subscription = await loadOwnTrial(userId);
    if (!subscription) {
      return NextResponse.json({ success: true, trialing: false });
    }

    const raw = Number(subscription.metadata?.trialReminderDays);
    return NextResponse.json({
      success: true,
      trialing: true,
      trialEndsAt: trialEndsAt(subscription.trial_end),
      reminderDays: isProTrialReminderDays(raw)
        ? raw
        : DEFAULT_PRO_TRIAL_REMINDER_DAYS,
    });
  } catch (err) {
    console.error("[stripe/trial-reminder] Failed to read the trial:", err);
    return NextResponse.json(
      { success: false, error: "Could not load your trial reminder." },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const reminderDays = body?.reminderDays;
  if (!isProTrialReminderDays(reminderDays)) {
    return NextResponse.json(
      { success: false, error: "reminderDays must be 0, 1 or 3." },
      { status: 400 },
    );
  }

  try {
    const subscription = await loadOwnTrial(userId);
    if (!subscription) {
      return NextResponse.json(
        { success: false, error: "Your free trial is not active." },
        { status: 409 },
      );
    }

    // Merge rather than replace: the subscription metadata also carries the
    // clerkId / plan / interval the webhook relies on.
    const updated = await getStripe().subscriptions.update(subscription.id, {
      metadata: { ...subscription.metadata, trialReminderDays: String(reminderDays) },
    });

    auditLog("pro_trial_reminder_updated", {
      userId,
      subscriptionId: subscription.id,
      reminderDays,
    });

    return NextResponse.json({
      success: true,
      reminderDays,
      trialEndsAt: trialEndsAt(updated.trial_end),
    });
  } catch (err) {
    console.error("[stripe/trial-reminder] Failed to update the reminder:", err);
    return NextResponse.json(
      { success: false, error: "Could not update your reminder. Please try again." },
      { status: 500 },
    );
  }
}
