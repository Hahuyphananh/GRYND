// src/app/api/stripe/webhook/route.ts
//
// POST — Stripe webhook for GRYND PRO membership AND one-time coin purchases.
//
// MEMBERSHIP GRANTS NO COINS. GRYND PRO buys ad-free/perk benefits only; a paid
// invoice is acknowledged and audited, never credited.
//
// ONE-TIME COIN PURCHASES ARE CREDITED HERE, and only here. A paid Checkout
// Session in `mode: "payment"` is handed to src/lib/tokens/coinFulfillment.ts,
// which verifies it against our own `stripe_checkout_sessions` ledger row and
// credits the existing wallet inside one transaction. No success page, client
// poll or /api/stripe/session-status call can grant coins.
//
// Handled events:
//   * `checkout.session.completed` / `checkout.session.async_payment_succeeded`:
//     mode=subscription records the new subscription row from our own checkout
//     metadata; mode=payment fulfils the coin purchase (see above). An unpaid
//     session only updates the ledger row's status and grants nothing.
//   * `customer.subscription.created/updated` sync the subscription row's
//     status + billing period; `customer.subscription.deleted` records the
//     cancellation (which drops the user back to the `free` state, since
//     membership is derived from the ACTIVE subscription only).
//   * `invoice.paid` is audited only — a paid invoice means the membership
//     renewed; nothing is credited.
//   * `invoice.payment_failed` flags the subscription `past_due`, which still
//     counts as active while Stripe retries, then `deleted` cancels it.
//   * `checkout.session.async_payment_failed` keeps the checkout ledger row's
//     status in sync (and grants nothing).
//   * `charge.refunded` REVERSES the purchase: the coins are taken back in
//     proportion to the amount refunded, idempotently per order, and never
//     below zero (src/lib/tokens/coinRefunds.ts). A wallet that cannot cover
//     the reversal is left untouched and flagged in the audit entry.
//   * `charge.dispute.created` is AUDITED ONLY (see the REFUNDS AND DISPUTES
//     note at the end of this file): a chargeback's outcome is not final when it
//     opens, so no balance move is made automatically.
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
import { resolveBillingIntervalForPriceId } from "../../../../lib/stripe/subscriptions";
import { fulfillCoinCheckoutSession } from "../../../../lib/tokens/coinFulfillment";
import { revokeCoinsForRefund } from "../../../../lib/tokens/coinRefunds";
import { isProBillingInterval } from "../../../../lib/proBilling";
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
  /** What Stripe actually charged, used to reconcile a one-time purchase. */
  amount_total?: number | null;
  currency?: string | null;
  metadata?: {
    clerkId?: string;
    packageKey?: string;
    planKey?: string;
    coins?: string;
  };
};

type StripeSubscriptionObject = {
  id: string;
  status: string;
  customer?: string | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
  // The subscription's current price, used to label the row with the billing
  // interval it is ACTUALLY on (object form on newer API versions).
  items?: {
    data?: Array<{ price?: string | { id?: string } | null }> | null;
  } | null;
  metadata?: { clerkId?: string; planKey?: string; billingInterval?: string };
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

        // One-time coin purchase. The ledger row, the paid amount, the
        // currency, the package and the coin award are all re-verified inside
        // coinFulfillment — a payload alone never decides a credit. An unpaid
        // session has already been short-circuited above, and the fulfilment
        // path independently refuses anything that is not `paid`.
        const outcome = await fulfillCoinCheckoutSession(session);
        if (outcome.status === "credited") {
          auditLog("stripe_coin_purchase_credited", {
            sessionId: session.id,
            userId: outcome.clerkId ?? null,
            packageKey: outcome.packageKey ?? null,
            coins: outcome.coins ?? 0,
            amountCents: outcome.amountCents ?? null,
            currency: outcome.currency ?? null,
          });
        } else {
          // Unknown session, already-fulfilled replay, unpaid/uncertain payment
          // or a payload/ledger disagreement. Nothing moved; the entry is the
          // trail an operator needs.
          auditLog("stripe_coin_purchase_not_credited", {
            sessionId: session.id,
            status: outcome.status,
            reason: outcome.reason ?? null,
            eventType: event.type,
          });
        }
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
      case "charge.refunded": {
        // Money went back: take the matching coins back too. The reversal is
        // proportional to the refunded amount, idempotent per order, and never
        // drives a wallet negative (see src/lib/tokens/coinRefunds.ts).
        const charge = event.data.object as unknown as {
          id?: string;
          payment_intent?: string | null;
          amount?: number | null;
          amount_refunded?: number | null;
          currency?: string | null;
          refunded?: boolean | null;
        };
        const reversal = await revokeCoinsForRefund(charge);
        auditLog("stripe_charge_refunded", {
          chargeId: charge.id ?? null,
          paymentIntentId: charge.payment_intent ?? null,
          amountRefundedCents: charge.amount_refunded ?? null,
          currency: charge.currency ?? null,
          status: reversal.status,
          revokedCoins: reversal.coins ?? 0,
          userId: reversal.clerkId ?? null,
          packageKey: reversal.packageKey ?? null,
          reason: reversal.reason ?? null,
          action:
            reversal.status === "revoked"
              ? "coins_revoked"
              : "manual_coin_reconciliation_required",
        });
        break;
      }
      case "charge.dispute.created": {
        // AUDIT ONLY — a dispute must never silently reverse (or re-add) coins.
        const dispute = event.data.object as unknown as {
          id?: string;
          payment_intent?: string | null;
          amount?: number | null;
          currency?: string | null;
          status?: string | null;
        };
        auditLog("stripe_charge_dispute_opened", {
          disputeId: dispute.id ?? null,
          paymentIntentId: dispute.payment_intent ?? null,
          amountCents: dispute.amount ?? null,
          currency: dispute.currency ?? null,
          status: dispute.status ?? null,
          action: "manual_coin_reconciliation_required",
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

  // The billing option this subscription is ACTUALLY on. Derived from its own
  // price (the accurate signal — it survives a plan change made in the Stripe
  // Dashboard), falling back to our checkout metadata. When neither is known we
  // leave the column untouched rather than clobbering a good value.
  const rawPrice = sub.items?.data?.[0]?.price;
  const priceId = typeof rawPrice === "string" ? rawPrice : (rawPrice?.id ?? null);
  const billingInterval =
    (await resolveBillingIntervalForPriceId(priceId)) ??
    (isProBillingInterval(sub.metadata?.billingInterval)
      ? sub.metadata.billingInterval
      : null);

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
    ...(billingInterval ? { billingInterval } : {}),
  };

  await db
    .insert(tokenSubscriptions)
    .values({ ...values, billingInterval: billingInterval ?? null })
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

// ── REFUNDS AND DISPUTES ───────────────────────────────────────────────────
//
// REFUNDS ARE REVERSED (`charge.refunded` → src/lib/tokens/coinRefunds.ts).
// The reversal is proportional to the refunded amount, counted from the
// `refund` rows already written against the order, so it is idempotent and a
// sequence of partial refunds clears exactly one order. The debit is
// conditional on the wallet still holding the coins, so `balance >= 0` (the
// invariant the wager layer depends on) is never broken: a spent wallet keeps
// what it cannot cover, and the audit entry records the shortfall for manual
// reconciliation.
//
// DISPUTES ARE AUDITED ONLY (`charge.dispute.created`). A chargeback is not
// final when it opens — the merchant often wins it — so reversing on open would
// need `charge.dispute.closed` to put the coins back, and that event is not
// subscribed today. Until it is, a dispute is a signal to an operator, not a
// balance move.
//
// The reconciliation trail for either case:
//   * `stripe_charge_refunded` (with `status`/`revokedCoins`) and
//     `stripe_charge_dispute_opened` audit entries with the charge/dispute id,
//     the PaymentIntent id, the amount and the currency (no card data),
//   * the fulfilled `stripe_checkout_sessions` row carries `payment_intent_id`
//     + `customer_id`, and its `token_amount`/`amount_cents`/`currency` are the
//     snapshot of what was sold,
//   * one `token_transactions` row of type `purchase` and, per refund, one of
//     type `refund`, both with `reference_type = 'stripe-checkout-session'` and
//     the session id.
