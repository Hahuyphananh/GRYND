// src/lib/tokens/coinFulfillment.ts
//
// THE one-time coin purchase fulfilment path. Called ONLY by the signed Stripe
// webhook (src/app/api/webhooks/stripe/route.ts) — never by a success page, a
// client poll or the session-status endpoint.
//
// WHAT IT DOES
//   Verifies a paid one-time Checkout Session against the server-created
//   `stripe_checkout_sessions` ledger row, then — in ONE database transaction —
//   locks that row, re-checks it is unfulfilled, credits the buyer's existing
//   `users.balance` through the shared `creditUserBalance` helper (so precision
//   and the peak-balance bookkeeping stay in one place), writes exactly one
//   `token_transactions` row of type `purchase`, and marks the session
//   fulfilled with the PaymentIntent/Customer ids for later reconciliation.
//
// WHAT IT TRUSTS
//   The LEDGER ROW, not the Stripe metadata. The coin award comes from
//   `token_amount` (written from the catalog when the session was created); the
//   amount and currency come from the row too. The session's metadata must
//   AGREE with the row — a mismatch refuses the credit rather than paying out
//   whatever a payload claims. A session with no ledger row is never credited.
//
// IDEMPOTENCY
//   Two layers, both inside one transaction:
//     1. `SELECT … FOR UPDATE` on the session row serialises concurrent
//        deliveries; the second one sees `fulfilled = true` and does nothing.
//     2. A durable `token_transactions` row keyed
//        `(reference_type = 'stripe-checkout-session', reference_id = session id)`
//        is checked before crediting and written in the same transaction, so a
//        replay can never add a second purchase entry.
//   The credit, the ledger entry and the `fulfilled` flag commit together or
//   not at all — there is no partial credit.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   No wallet ceiling is introduced, no wager limit, escrow or payout cap is
//   touched, and no refund/dispute reversal is automated (see the webhook's
//   refund/dispute audit events and the follow-up note there).

import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { stripeCheckoutSessions, tokenTransactions } from "../../db/schema";
import { creditUserBalance } from "./creditTokens";

/** `token_transactions.reference_type` for a one-time Stripe purchase. */
export const PURCHASE_REFERENCE_TYPE = "stripe-checkout-session";

/** The subset of a Stripe Checkout Session this path reads. */
export type CoinCheckoutSession = {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  payment_intent?: string | { id?: string } | null;
  customer?: string | null;
  metadata?: {
    clerkId?: string;
    packageKey?: string;
    coins?: string;
  } | null;
};

/** The ledger columns fulfilment reconciles against. */
export type CheckoutLedgerRow = {
  sessionId: string;
  clerkId: string;
  packageKey: string | null;
  sessionMode: string;
  tokenAmount: number;
  amountCents: number;
  currency: string;
  paymentStatus: string;
  fulfilled: boolean;
};

export type CoinFulfillmentStatus =
  | "credited"
  | "already_fulfilled"
  | "unknown_session"
  | "not_paid"
  | "mismatch";

/**
 * A flat decision object (rather than a discriminated union) because this
 * project compiles with `strict` off, where `!x.ok` does not narrow — same
 * rationale as the annotated result in src/lib/tokens/wager.ts.
 */
export type CoinFulfillmentDecision = {
  ok: boolean;
  status: CoinFulfillmentStatus;
  /** Why the credit was refused (safe for logs — never payment data). */
  reason?: string;
  /** The wallet owner, from the LEDGER row. */
  clerkId?: string;
  /** The coins to credit, from the LEDGER row. */
  coins?: number;
};

/**
 * Decide whether this session may be credited. PURE — no DB, no Stripe, no env
 * — so every verification rule is unit-testable.
 *
 * Refusal is always the safe answer: an unknown row, an unpaid session, a
 * subscription session, a spent (already fulfilled) order or any disagreement
 * between the payload and the ledger awards nothing.
 */
export function planCoinFulfillment(
  session: CoinCheckoutSession | null | undefined,
  row: CheckoutLedgerRow | null | undefined,
): CoinFulfillmentDecision {
  if (!session || typeof session.id !== "string" || session.id === "") {
    return { ok: false, status: "mismatch", reason: "session has no id" };
  }
  if (!row || row.sessionId !== session.id) {
    return { ok: false, status: "unknown_session", reason: "no ledger row for this session" };
  }

  // A duplicate delivery of an order we already credited is a no-op, not an
  // error — checked BEFORE payment, because Stripe retries the same paid event.
  if (row.fulfilled === true) {
    return { ok: false, status: "already_fulfilled", reason: "ledger row is already fulfilled" };
  }

  // 1. One-time payment only. A subscription session never credits coins.
  if (session.mode !== "payment") {
    return { ok: false, status: "mismatch", reason: "session is not a one-time payment" };
  }
  if (row.sessionMode !== "payment") {
    return { ok: false, status: "mismatch", reason: "ledger row is not a one-time payment" };
  }

  // 2. Money must actually be confirmed. `unpaid` (delayed method still
  //    settling), `no_payment_required` and any failed/canceled state award
  //    nothing; only Stripe's `paid` is creditable.
  if (session.payment_status !== "paid") {
    return {
      ok: false,
      status: "not_paid",
      reason: `payment status is ${session.payment_status ?? "unknown"}`,
    };
  }

  // 3. The award comes from the ledger, never from the payload.
  const coins = Number(row.tokenAmount);
  if (!Number.isInteger(coins) || coins <= 0) {
    return { ok: false, status: "mismatch", reason: "ledger coin amount is invalid" };
  }

  // 4. Identity: the authenticated user who created the session.
  const metadataClerkId = session.metadata?.clerkId;
  if (!row.clerkId || metadataClerkId !== row.clerkId) {
    return { ok: false, status: "mismatch", reason: "session user does not match the ledger" };
  }

  // 5. Package.
  const metadataPackageKey = session.metadata?.packageKey;
  if (!row.packageKey || metadataPackageKey !== row.packageKey) {
    return { ok: false, status: "mismatch", reason: "session package does not match the ledger" };
  }

  // 6. Award agreement — a payload claiming more (or fewer) coins than the
  //    ledger recorded is never paid out.
  const metadataCoins = Number(session.metadata?.coins);
  if (!Number.isFinite(metadataCoins) || metadataCoins !== coins) {
    return { ok: false, status: "mismatch", reason: "session coin award does not match the ledger" };
  }

  // 7. Price and currency actually charged.
  const amountTotal = Number(session.amount_total);
  if (!Number.isFinite(amountTotal) || amountTotal !== Number(row.amountCents)) {
    return { ok: false, status: "mismatch", reason: "amount charged does not match the ledger" };
  }
  const sessionCurrency = String(session.currency ?? "").toLowerCase();
  const ledgerCurrency = String(row.currency ?? "").toLowerCase();
  if (!sessionCurrency || sessionCurrency !== ledgerCurrency) {
    return { ok: false, status: "mismatch", reason: "currency charged does not match the ledger" };
  }

  return { ok: true, status: "credited", clerkId: row.clerkId, coins };
}

export type CoinFulfillmentResult = {
  status: CoinFulfillmentStatus;
  reason?: string;
  /** Set on `credited` — the wallet owner and what was added. */
  clerkId?: string;
  coins?: number;
  balance?: number;
  /** Reconciliation data (no card or customer-identifying details). */
  amountCents?: number;
  currency?: string;
  packageKey?: string | null;
};

/** A PaymentIntent id from either the string or expanded form. */
function paymentIntentId(value: CoinCheckoutSession["payment_intent"]): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

/**
 * The transaction boundary fulfilment needs. `db` satisfies it; tests pass a
 * fake so the atomic sequence (lock → verify → credit → ledger → fulfilled) can
 * be exercised without a database. Nothing else about the executor is used.
 */
export type CoinFulfillmentExecutor = {
  transaction: (fn: (tx: any) => Promise<CoinFulfillmentResult>) => Promise<CoinFulfillmentResult>;
};

/**
 * Fulfil one paid one-time Checkout Session.
 *
 * Everything that moves state happens inside ONE transaction: the row lock,
 * the duplicate check, the balance credit, the purchase ledger entry and the
 * `fulfilled` flag. A thrown error (e.g. a missing wallet) rolls all of it
 * back, so the webhook answers 500 and Stripe retries — never a partial credit.
 */
export async function fulfillCoinCheckoutSession(
  session: CoinCheckoutSession,
  executor: CoinFulfillmentExecutor = db as unknown as CoinFulfillmentExecutor,
): Promise<CoinFulfillmentResult> {
  if (!session || typeof session.id !== "string" || session.id === "") {
    return { status: "mismatch", reason: "session has no id" };
  }

  return executor.transaction(async (tx) => {
    // 1. Lock the ledger row. Concurrent deliveries of the same event queue
    //    here, and the second one observes the first one's `fulfilled = true`.
    const rows = await tx
      .select({
        sessionId: stripeCheckoutSessions.sessionId,
        clerkId: stripeCheckoutSessions.clerkId,
        packageKey: stripeCheckoutSessions.packageKey,
        sessionMode: stripeCheckoutSessions.sessionMode,
        tokenAmount: stripeCheckoutSessions.tokenAmount,
        amountCents: stripeCheckoutSessions.amountCents,
        currency: stripeCheckoutSessions.currency,
        paymentStatus: stripeCheckoutSessions.paymentStatus,
        fulfilled: stripeCheckoutSessions.fulfilled,
      })
      .from(stripeCheckoutSessions)
      .where(eq(stripeCheckoutSessions.sessionId, session.id))
      .for("update");

    const row = rows[0] ?? null;
    const decision = planCoinFulfillment(session, row);

    if (!decision.ok) {
      return { status: decision.status, reason: decision.reason };
    }

    const clerkId = String(decision.clerkId);
    const coins = Number(decision.coins);

    // 2. Durable second guard: has this session already written a purchase
    //    entry? (Belt and braces on top of the row lock — e.g. a row that was
    //    reverted by hand.)
    const existing = await tx
      .select({ id: tokenTransactions.id })
      .from(tokenTransactions)
      .where(
        and(
          eq(tokenTransactions.referenceType, PURCHASE_REFERENCE_TYPE),
          eq(tokenTransactions.referenceId, session.id),
        ),
      )
      .limit(1);

    const reconciliation = {
      paymentStatus: "paid",
      paymentIntentId: paymentIntentId(session.payment_intent),
      customerId: typeof session.customer === "string" ? session.customer : null,
      updatedAt: new Date(),
    };

    if (existing.length > 0) {
      // The balance already moved in an earlier attempt but the flag did not
      // commit — close the order without crediting again.
      await tx
        .update(stripeCheckoutSessions)
        .set({ ...reconciliation, fulfilled: true })
        .where(eq(stripeCheckoutSessions.sessionId, session.id));
      return {
        status: "already_fulfilled",
        reason: "a purchase ledger entry already exists for this session",
        clerkId,
        coins,
        packageKey: row?.packageKey ?? null,
      };
    }

    // 3. Credit the EXISTING wallet through the shared helper, inside this
    //    transaction. A missing wallet throws, which rolls back the whole
    //    transaction (no ledger row, no fulfilled flag) and makes Stripe retry.
    const balance = await creditUserBalance(clerkId, coins, tx);
    if (balance === null) {
      throw new Error("Purchasing user's wallet was not found");
    }

    // 4. Exactly one purchase entry, in the same transaction as the credit.
    await tx.insert(tokenTransactions).values({
      clerkId,
      type: "purchase",
      amount: coins,
      referenceType: PURCHASE_REFERENCE_TYPE,
      referenceId: session.id,
      note: `stripe:${row?.packageKey ?? "package"}`,
    });

    // 5. Mark the order fulfilled with the ids needed to reconcile a later
    //    refund/dispute (no card data is ever stored).
    await tx
      .update(stripeCheckoutSessions)
      .set({ ...reconciliation, fulfilled: true })
      .where(eq(stripeCheckoutSessions.sessionId, session.id));

    return {
      status: "credited",
      clerkId,
      coins,
      balance,
      amountCents: Number(row?.amountCents ?? 0),
      currency: String(row?.currency ?? ""),
      packageKey: row?.packageKey ?? null,
    };
  });
}
