// src/app/api/stripe/webhook/route.ts
//
// POST — Stripe webhook for GRYND PRO membership lifecycle.
//
// NO TOKENS ARE EVER GRANTED HERE. GRYND has no token currency, and
// membership buys ad-free/analytics/support perks only. Paid invoices are
// acknowledged and audited, never credited — there is no balance write and no
// token-transaction write anywhere in this file.
//
// Handled events:
//   * `checkout.session.completed` (mode=subscription) records the new
//     subscription row from our own checkout metadata.
//   * `customer.subscription.created/updated` sync the subscription row's
//     status + billing period; `customer.subscription.deleted` records the
//     cancellation (which drops the user back to the `free` state, since
//     membership is derived from the ACTIVE subscription only).
//   * `invoice.paid` is audited only — a paid invoice means the membership
//     renewed; nothing is credited.
//   * `invoice.payment_failed` flags the subscription `past_due`, which still
//     counts as active while Stripe retries, then `deleted` cancels it.
//   * `checkout.session.async_payment_*` keep the checkout ledger row's status
//     in sync for the Shop's return-to-site polling.
//
// Signature is verified with the Stripe SDK; the secret lives in
// STRIPE_WEBHOOK_SECRET. A bad/missing signature is rejected before any state
// changes. Idempotency is database-level: `token_subscriptions.stripe_
// subscription_id` is UNIQUE and every write is an upsert on it, so replayed
// or concurrent deliveries converge on the same row.

import { NextResponse } from "next/server";
import { db } from "../../../../db";
import {
  stripeCheckoutSessions,
  tokenSubscriptions,
} from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { getStripe, getStripeWebhookSecret } from "../../../../lib/stripe";
import { auditLog } from "../../../../lib/security/auditLog";
import { logError } from "../../../../lib/logError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StripeSession = {
  id: string;
  mode?: string;
  payment_status?: string;
  payment_intent?: string | null;
  customer?: string | null;
  subscription?: string | null;
  metadata?: { clerkId?: string; packageKey?: string; planKey?: string };
};

type StripeSubscriptionObject = {
  id: string;
  status: string;
  customer?: string | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  metadata?: { clerkId?: string; planKey?: string };
};

type StripeInvoiceObject = {
  id: string;
  subscription?: string | null;
  period_start?: number | null;
  period_end?: number | null;
  amount_paid?: number | null;
};

export async function POST(req: Request) {
  const secret = getStripeWebhookSecret();
  if (!secret) {
    // Fail closed — never credit blindly without a configured secret.
    return NextResponse.json({ success: false, error: "Webhook not configured" }, { status: 503 });
  }

  const rawBody = await req.text().catch(() => "");
  const signature = req.headers.get("stripe-signature") || "";

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    auditLog("stripe_webhook_bad_signature", {
      message: err instanceof Error ? err.message : "invalid signature",
    });
    return NextResponse.json({ success: false, error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const session = event.data.object as unknown as StripeSession;
        if (session.payment_status === "unpaid") {
          // Delayed-notification method still settling — awaiting the next event.
          await updateStatus(session.id, session.payment_status ?? "unpaid");
          break;
        }
        if (session.mode === "subscription") {
          // Record the subscription from our own checkout metadata. Nothing is
          // credited — GRYND PRO grants no tokens.
          await recordSubscriptionFromCheckout(session);
          break;
        }
        // Token top-up packs no longer exist, so a non-subscription checkout
        // session can never grant anything. Acknowledge + audit it.
        auditLog("stripe_checkout_session_ignored", { sessionId: session.id });
        break;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as unknown as StripeSession;
        await updateStatus(session.id, "failed");
        auditLog("stripe_payment_failed", { sessionId: session.id });
        break;
      }
      case "invoice.paid": {
        const invoice = event.data.object as unknown as StripeInvoiceObject;
        // GRYND PRO grants no tokens: a paid invoice only confirms the
        // membership is active/renewed. Audit it and move on — there is no
        // balance credit and no token transaction.
        auditLog("stripe_subscription_invoice_paid", {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscription ?? null,
        });
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as unknown as StripeInvoiceObject;
        if (!invoice.subscription) break;
        // Flag the subscription as past due; the customer gets a retry window
        // before Stripe cancels it (which `customer.subscription.deleted`
        // records as canceled).
        await db
          .update(tokenSubscriptions)
          .set({ status: "past_due", updatedAt: new Date() })
          .where(eq(tokenSubscriptions.stripeSubscriptionId, invoice.subscription));
        auditLog("stripe_subscription_payment_failed", {
          invoiceId: invoice.id,
          subscriptionId: invoice.subscription,
        });
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as unknown as StripeSubscriptionObject;
        await recordSubscription(sub);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as unknown as StripeSubscriptionObject;
        await recordSubscription({ ...sub, status: "canceled" });
        auditLog("stripe_subscription_canceled", {
          subscriptionId: sub.id,
        });
        break;
      }
      default:
        // Acknowledge all events; only the ones above touch state.
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    await logError({
      errorType: "stripe_webhook_error",
      errorMessage: err instanceof Error ? err.message : "Stripe webhook failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/stripe/webhook",
      metadata: { eventType: event.type },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}

async function updateStatus(sessionId: string, paymentStatus: string) {
  await db
    .update(stripeCheckoutSessions)
    .set({ paymentStatus, updatedAt: new Date() })
    .where(eq(stripeCheckoutSessions.sessionId, sessionId));
}

/**
 * Insert or refresh the subscription row for a Stripe subscription. Idempotent
 * via the UNIQUE `stripe_subscription_id`. Subscriptions not started through
 * our checkout (no clerkId/planKey metadata) are ignored — we only track and
 * grant for subscriptions we created.
 */
async function recordSubscription(sub: StripeSubscriptionObject) {
  const clerkId = sub.metadata?.clerkId ?? "";
  const planKey = sub.metadata?.planKey ?? "";
  if (!clerkId || !planKey || !sub.id) {
    return;
  }

  const values = {
    clerkId,
    planKey,
    stripeSubscriptionId: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : null,
    status: sub.status || "active",
    currentPeriodStart: sub.current_period_start
      ? new Date(sub.current_period_start * 1000)
      : null,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
  };

  await db
    .insert(tokenSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: tokenSubscriptions.stripeSubscriptionId,
      set: { ...values, updatedAt: new Date() },
    });
}

/**
 * The checkout.session.completed path for subscription sessions: record the
 * subscription row (fetching the Stripe subscription for the current period /
 * status). This is the ONLY thing checkout does — nothing is granted here (or
 * on any other event).
 */
async function recordSubscriptionFromCheckout(session: StripeSession) {
  if (!session.subscription) {
    return;
  }

  let sub: StripeSubscriptionObject = {
    id: session.subscription,
    status: "active",
    customer: session.customer ?? null,
    metadata: session.metadata,
  };

  try {
    const fetched = (await getStripe().subscriptions.retrieve(
      session.subscription
    )) as unknown as StripeSubscriptionObject;
    sub = { ...fetched, metadata: session.metadata ?? fetched.metadata };
  } catch {
    // Keep the defaults above — the customer.subscription.created/updated
    // events will correct status/period if our fetch fails.
  }

  await recordSubscription(sub);
}

