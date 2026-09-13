// src/app/api/stripe/webhook/route.ts
//
// POST — Stripe webhook that fulfils token purchases and Grynd+ subscription
// grants.
//
// One-time fulfilment rules (never fulfil on the success page — customers may
// not reload it):
//   * `checkout.session.completed` and `checkout.session.async_payment_succeeded`
//     both trigger a credit — but ONLY when `payment_status !== 'unpaid'`
//     (delayed-notification methods reach `completed` while still unpaid, and
//     fulfilling then grants tokens to a payment that later fails).
//   * `checkout.session.async_payment_failed` marks the session failed.
//
// Subscription fulfilment:
//   * `checkout.session.completed` (mode=subscription) records the new
//     subscription row — tokens are NOT granted at checkout.
//   * `invoice.paid` grants the plan's monthly token amount, idempotent on the
//     Stripe invoice id (the first invoice pays at checkout, so the first
//     month lands immediately; renewals credit each following month).
//   * `customer.subscription.created/updated/deleted` keep the subscription
//     row's lifecycle status in sync; `invoice.payment_failed` flags past_due.
//
// Signature is verified with the Stripe SDK; the secret lives in
// STRIPE_WEBHOOK_SECRET. A bad/missing signature is rejected before any state
// changes. Idempotency is database-level for both flows:
//   * one-time: `stripe_checkout_sessions.session_id` is UNIQUE and `fulfilled`
//     flips exactly once, inside the same transaction as the atomic credit;
//   * subscriptions: `token_subscription_credits.stripe_invoice_id` is UNIQUE
//     and the grant runs in the same transaction as the atomic credit.
// Token amounts always come from OUR rows (server-resolved), never from the
// webhook payload.

import { NextResponse } from "next/server";
import { db } from "../../../../db";
import {
  stripeCheckoutSessions,
  tokenSubscriptionPlans,
  tokenSubscriptions,
  tokenTransactions,
  users,
} from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { getStripe, getStripeWebhookSecret } from "../../../../lib/stripe";
import { creditUserBalance } from "../../../../lib/tokens/creditTokens";
import { grantSubscriptionInvoiceTokens } from "../../../../lib/stripe/subscriptions";
import { auditLog } from "../../../../lib/security/auditLog";
import { logError } from "../../../../lib/logError";
import { sendDepositProcessingEmail, sendDepositSuccessEmail, sendWithdrawalRequestedEmail, sendWithdrawalDelayEmail } from "../../../../lib/emails/payments";

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
          // Record the subscription — monthly tokens are granted per paid
          // invoice, never at checkout.
          await recordSubscriptionFromCheckout(session);
          break;
        }
        await fulfill(session);
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
        if (!invoice.subscription) {
          // A one-time (non-subscription) invoice — nothing to grant.
          break;
        }
        await grantSubscriptionTokens(invoice);
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
 * Connect a paid one-time session to tokens, atomically and idempotently.
 *
 * Runs inside a transaction: reads the ledger row, and if it hasn't been
 * fulfilled yet, marks it fulfilled AND credits `users.balance` in one atomic
 * step. If a retry re-delivers the same event, `fulfilled` is already true and
 * the credit is skipped.
 */
async function fulfill(session: StripeSession) {
  let rowData: { clerkId: string; tokenAmount: number; packageKey: string | null; amountCents: number } | null = null;

  await db.transaction(async (tx) => {
    const row = await tx
      .select()
      .from(stripeCheckoutSessions)
      .where(eq(stripeCheckoutSessions.sessionId, session.id))
      .limit(1)
      .then((r) => r[0]);

    if (!row) {
      // A session we never created (or already cleaned up) — do not credit.
      auditLog("stripe_webhook_unknown_session", { sessionId: session.id });
      return;
    }

    if (row.fulfilled) {
      // Already credited for this session — idempotent replay, skip.
      return;
    }

    // Capture data for post-transaction use
    rowData = {
      clerkId: row.clerkId,
      tokenAmount: Number(row.tokenAmount),
      packageKey: row.packageKey,
      amountCents: row.amountCents,
    };

    // Credit the server-resolved token amount, then mark fulfilled inside
    // the same transaction so a crash can't credit without marking.
    await creditUserBalance(row.clerkId, Number(row.tokenAmount), tx as never);

    // Durable, auditable transaction record — written in the SAME transaction
    // as the balance credit, so balance and history can never diverge.
    await tx.insert(tokenTransactions).values({
      clerkId: row.clerkId,
      type: "purchase",
      amount: Number(row.tokenAmount),
      referenceType: "stripe_session",
      referenceId: session.id,
      note: row.packageKey ? `Token package: ${row.packageKey}` : null,
    });

    await tx
      .update(stripeCheckoutSessions)
      .set({
        fulfilled: true,
        paymentStatus: session.payment_status ?? "paid",
        paymentIntentId: session.payment_intent ?? null,
        customerId: session.customer ?? null,
        updatedAt: new Date(),
      })
      .where(eq(stripeCheckoutSessions.sessionId, session.id));
  });

  // Send deposit success email (outside transaction, fire-and-forget)
  if (rowData && session.metadata?.clerkId) {
    try {
      const userRow = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.clerkId, session.metadata.clerkId))
        .limit(1);
      if (userRow[0]?.email) {
        await sendDepositSuccessEmail(
          { clerkId: session.metadata.clerkId, email: userRow[0].email, name: userRow[0].name },
          rowData.tokenAmount
        );
      }
    } catch (err) {
      console.error("[stripe webhook] Deposit success email failed:", err);
    }
  }

  // Audit log (fire-and-forget)
  if (rowData) {
    auditLog("stripe_payment_completed", {
      userId: rowData.clerkId,
      packageKey: rowData.packageKey,
      sessionId: session.id,
      tokenAmount: rowData.tokenAmount,
      amountCents: rowData.amountCents,
    });
  }
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
 * status). Grants still happen via invoice.paid — never here.
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

/**
 * Grant one month of tokens for a paid subscription invoice. The plan key is
 * read from the subscription's metadata (set at checkout), never from the
 * invoice payload; the grant itself is idempotent per invoice id.
 */
async function grantSubscriptionTokens(invoice: StripeInvoiceObject) {
  if (!invoice.subscription) {
    return;
  }

  // Paid-token gate: only grant the membership token award on invoices that
  // actually paid. A $0 invoice (e.g. a free-trial period starts with a $0
  // "paid" invoice) must not print tokens — the first real charge grants on
  // its own paid invoice, and the credit is still idempotent per invoice id.
  if (typeof invoice.amount_paid === "number" && !(invoice.amount_paid > 0)) {
    auditLog("stripe_subscription_no_payment_skip", {
      invoiceId: invoice.id,
      amountPaid: invoice.amount_paid,
    });
    return;
  }

  let sub: StripeSubscriptionObject | null = null;
  try {
    sub = (await getStripe().subscriptions.retrieve(
      invoice.subscription
    )) as unknown as StripeSubscriptionObject;
  } catch {
    // Unknown subscription — cannot map to a plan; nothing to grant.
  }

  const clerkId = sub?.metadata?.clerkId ?? "";
  const planKey = sub?.metadata?.planKey ?? "";
  if (!sub || !clerkId || !planKey) {
    auditLog("stripe_subscription_unknown_plan", {
      subscriptionId: invoice.subscription,
      invoiceId: invoice.id,
    });
    return;
  }

  const plan = await db
    .select({
      monthlyTokens: tokenSubscriptionPlans.monthlyTokens,
      name: tokenSubscriptionPlans.name,
    })
    .from(tokenSubscriptionPlans)
    .where(eq(tokenSubscriptionPlans.key, planKey))
    .limit(1)
    .then((r) => r[0]);

  if (!plan) {
    auditLog("stripe_subscription_unknown_plan", { planKey, invoiceId: invoice.id });
    return;
  }

  const granted = await grantSubscriptionInvoiceTokens({
    clerkId,
    planKey,
    invoiceId: invoice.id,
    amount: Number(plan.monthlyTokens),
    periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
    periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
  });

  if (granted) {
    auditLog("stripe_subscription_credit", {
      userId: clerkId,
      planKey,
      invoiceId: invoice.id,
      tokenAmount: Number(plan.monthlyTokens),
    });

    // Send subscription deposit success email (fire-and-forget)
    try {
      const userRow = await db
        .select({ email: users.email, name: users.name })
        .from(users)
        .where(eq(users.clerkId, clerkId))
        .limit(1);
      if (userRow[0]?.email) {
        await sendDepositSuccessEmail(
          { clerkId, email: userRow[0].email, name: userRow[0].name },
          Number(plan.monthlyTokens)
        );
      }
    } catch (err) {
      console.error("[stripe webhook] Subscription deposit email failed:", err);
    }
  }
}
