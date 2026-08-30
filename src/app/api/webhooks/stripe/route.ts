// src/app/api/stripe/webhook/route.ts
//
// POST — Stripe webhook that fulfils token purchases.
//
// Fulfilment rules (never fulfil on the success page — customers may not
// reload it):
//   * `checkout.session.completed` and `checkout.session.async_payment_succeeded`
//     both trigger a credit — but ONLY when `payment_status !== 'unpaid'`
//     (delayed-notification methods reach `completed` while still unpaid, and
//     fulfilling then grants tokens to a payment that later fails).
//   * `checkout.session.async_payment_failed` marks the session failed.
//   * Signature is verified with the Stripe SDK; the secret lives in
//     STRIPE_WEBHOOK_SECRET. A bad/missing signature is rejected before any
//     state changes.
//   * Idempotency is database-level: `stripe_checkout_sessions.session_id` is
//     UNIQUE and `fulfilled` flips exactly once, inside the same transaction
//     as the atomic balance credit — a replay can never double-credit.
//   * Token amount is read from OUR ledger row (server-resolved at checkout),
//     never from the webhook payload.

import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { stripeCheckoutSessions, tokenTransactions } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { getStripe, getStripeWebhookSecret } from "../../../../lib/stripe";
import { creditUserBalance } from "../../../../lib/tokens/creditTokens";
import { auditLog } from "../../../../lib/security/auditLog";
import { logError } from "../../../../lib/logError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StripeSession = {
  id: string;
  payment_status?: string;
  payment_intent?: string | null;
  customer?: string | null;
  metadata?: { clerkId?: string; packageKey?: string };
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
        await fulfill(session);
        break;
      }
      case "checkout.session.async_payment_failed": {
        const session = event.data.object as unknown as StripeSession;
        await updateStatus(session.id, "failed");
        auditLog("stripe_payment_failed", { sessionId: session.id });
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
 * Connect a paid session to tokens, atomically and idempotently.
 *
 * Runs inside a transaction: reads the ledger row, and if it hasn't been
 * fulfilled yet, marks it fulfilled AND credits `users.balance` in one atomic
 * step. If a retry re-delivers the same event, `fulfilled` is already true and
 * the credit is skipped.
 */
async function fulfill(session: StripeSession) {
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

    auditLog("stripe_payment_completed", {
      userId: row.clerkId,
      packageKey: row.packageKey,
      sessionId: session.id,
      tokenAmount: Number(row.tokenAmount),
      amountCents: row.amountCents,
    });
  });
}
