// src/lib/tokens/coinRefunds.ts
//
// THE one-time coin purchase REVERSAL path. Called ONLY by the signed Stripe
// webhook (src/app/api/webhooks/stripe/route.ts) for a `charge.refunded` event
// that names a PaymentIntent we sold coins against.
//
// WHY THIS EXISTS
//   A purchase credit was permanent, so money returned in Stripe left the coins
//   in the buyer's wallet with nothing but an audit line to show for it. This
//   module takes the coins back when — and only when — Stripe says money was
//   actually returned.
//
// WHAT IT TRUSTS
//   The LEDGER ROW (`stripe_checkout_sessions`), joined by the PaymentIntent id
//   Stripe put on the charge. The coin award, the price paid and the currency
//   all come from that row; the charge only supplies the refunded AMOUNT, which
//   is what decides how much of the order was given back.
//
// PROPORTIONAL, NOT ALL-OR-NOTHING
//   A partial refund reverses the same fraction of the coins:
//     target = floor(tokenAmount × amountRefunded ÷ amountCharged)
//   and only the DELTA beyond what earlier refund events already reversed is
//   taken, so three refunds of a third each clear exactly one order.
//
// IDEMPOTENCY
//   The reversal is recorded as `token_transactions` rows of type `refund`
//   against the SAME `(stripe-checkout-session, session id)` reference the
//   purchase used. The sum of those rows IS the amount already reversed, so a
//   replayed event computes a zero delta and does nothing. The session row is
//   locked (`SELECT … FOR UPDATE`) for the whole decision, so two concurrent
//   deliveries serialise instead of both taking the delta.
//
// NEVER NEGATIVE
//   Coins may already be staked or lost. The debit is conditional
//   (`… WHERE balance >= coins`), so the wallet invariant `balance >= 0` holds
//   and a wallet that cannot cover the reversal is left untouched, with the
//   shortfall reported for manual reconciliation rather than driven into debt.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   Disputes are not reversed here: a chargeback's outcome is not final when it
//   opens, so `charge.dispute.created` stays an audit event (see the webhook).
//   Re-crediting a won dispute would need `dispute.closed`, which is not
//   subscribed today.

import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { stripeCheckoutSessions, tokenTransactions, users } from "../../db/schema";
import { PURCHASE_REFERENCE_TYPE } from "./coinFulfillment";

/** The subset of a Stripe Charge this path reads. */
export type RefundCharge = {
  id?: string | null;
  payment_intent?: string | null;
  /** What was originally charged, in minor units. */
  amount?: number | null;
  /** Cumulative amount refunded so far, in minor units. */
  amount_refunded?: number | null;
  currency?: string | null;
  refunded?: boolean | null;
};

/** The ledger columns a reversal reconciles against. */
export type RefundLedgerRow = {
  sessionId: string;
  clerkId: string;
  packageKey: string | null;
  sessionMode: string;
  tokenAmount: number;
  amountCents: number;
  currency: string;
  fulfilled: boolean;
};

export type CoinRefundStatus =
  | "revoked"
  | "already_reversed"
  | "unknown_purchase"
  | "not_fulfilled"
  | "not_refunded"
  | "mismatch"
  | "insufficient_balance";

/**
 * A flat decision object (rather than a discriminated union) because this
 * project compiles with `strict` off, where `!x.ok` does not narrow — same
 * rationale as `planCoinFulfillment`.
 */
export type CoinRefundDecision = {
  ok: boolean;
  status: CoinRefundStatus;
  /** Why nothing was reversed (safe for logs — never payment data). */
  reason?: string;
  /** The coins this event should take back. */
  coinsToRevoke?: number;
  /** Coins reversed across every refund event for this order. */
  totalReverseTarget?: number;
};

/**
 * Decide how many coins a refund should take back. PURE — no DB, no Stripe, no
 * env — so every rule is unit-testable.
 *
 * Refusal is always the safe answer: an unknown PaymentIntent, an order that
 * never credited, a currency that does not match, or a refund we already
 * accounted for reverses nothing.
 */
export function planCoinRefund(
  charge: RefundCharge | null | undefined,
  row: RefundLedgerRow | null | undefined,
  alreadyReversed: number,
): CoinRefundDecision {
  if (!charge || !charge.payment_intent) {
    return { ok: false, status: "mismatch", reason: "charge has no payment intent" };
  }
  if (!row || !row.sessionId) {
    return { ok: false, status: "unknown_purchase", reason: "no purchase for this payment intent" };
  }

  // Only an order that actually paid out coins can be reversed.
  if (row.sessionMode !== "payment") {
    return { ok: false, status: "mismatch", reason: "not a one-time purchase" };
  }
  if (row.fulfilled !== true) {
    return { ok: false, status: "not_fulfilled", reason: "purchase was never fulfilled" };
  }

  const charged = Number(charge.amount);
  const refunded = Number(charge.amount_refunded);
  if (!Number.isFinite(charged) || charged <= 0) {
    return { ok: false, status: "mismatch", reason: "charge amount is unknown" };
  }
  if (!Number.isFinite(refunded) || refunded <= 0) {
    return { ok: false, status: "not_refunded", reason: "nothing has been refunded" };
  }

  const chargeCurrency = String(charge.currency ?? "").toLowerCase();
  const ledgerCurrency = String(row.currency ?? "").toLowerCase();
  if (!chargeCurrency || chargeCurrency !== ledgerCurrency) {
    return { ok: false, status: "mismatch", reason: "refund currency does not match the charge" };
  }

  const coins = Number(row.tokenAmount);
  if (!Number.isInteger(coins) || coins <= 0) {
    return { ok: false, status: "mismatch", reason: "ledger coin amount is invalid" };
  }

  const prior = Number(alreadyReversed);
  if (!Number.isFinite(prior) || prior < 0) {
    return { ok: false, status: "mismatch", reason: "accounted reversal total is invalid" };
  }

  // Stripe's `amount_refunded` is cumulative; cap it at the charge so an
  // over-reported value can never reverse more than the order awarded.
  const refundedThisOrder = Math.min(refunded, charged);
  const target = Math.min(coins, Math.floor((coins * refundedThisOrder) / charged));
  const delta = target - prior;

  if (delta <= 0) {
    return {
      ok: false,
      status: "already_reversed",
      reason: "this refund was already accounted for",
      totalReverseTarget: target,
    };
  }

  return {
    ok: true,
    status: "revoked",
    coinsToRevoke: delta,
    totalReverseTarget: target,
  };
}

export type CoinRefundResult = {
  status: CoinRefundStatus;
  reason?: string;
  /** Set on `revoked` — the wallet owner and what was taken back. */
  clerkId?: string;
  coins?: number;
  balance?: number;
  packageKey?: string | null;
  amountRefundedCents?: number;
  currency?: string;
};

/**
 * The transaction boundary a reversal needs. `db` satisfies it; tests pass a
 * fake so the atomic sequence (lock → decide → debit → ledger) can be exercised
 * without a database.
 */
export type CoinRefundExecutor = {
  transaction: (fn: (tx: any) => Promise<CoinRefundResult>) => Promise<CoinRefundResult>;
};

/**
 * Reverse the coins behind one refunded charge.
 *
 * Everything that moves state happens inside ONE transaction: the ledger row
 * lock, the refunded-so-far check, the conditional debit and the refund ledger
 * entry. A thrown error rolls all of it back, so the webhook answers 500 and
 * Stripe retries — never a half-applied reversal.
 */
export async function revokeCoinsForRefund(
  charge: RefundCharge,
  executor: CoinRefundExecutor = db as unknown as CoinRefundExecutor,
): Promise<CoinRefundResult> {
  if (!charge || !charge.payment_intent) {
    return { status: "mismatch", reason: "charge has no payment intent" };
  }

  return executor.transaction(async (tx) => {
    // 1. Lock the order this charge paid for. Concurrent deliveries of the same
    //    (or a later) refund queue here and observe each other's ledger rows.
    const rows = await tx
      .select({
        sessionId: stripeCheckoutSessions.sessionId,
        clerkId: stripeCheckoutSessions.clerkId,
        packageKey: stripeCheckoutSessions.packageKey,
        sessionMode: stripeCheckoutSessions.sessionMode,
        tokenAmount: stripeCheckoutSessions.tokenAmount,
        amountCents: stripeCheckoutSessions.amountCents,
        currency: stripeCheckoutSessions.currency,
        fulfilled: stripeCheckoutSessions.fulfilled,
      })
      .from(stripeCheckoutSessions)
      .where(
        and(
          eq(stripeCheckoutSessions.paymentIntentId, String(charge.payment_intent)),
          eq(stripeCheckoutSessions.sessionMode, "payment"),
        ),
      )
      .for("update")
      .limit(1);

    const row = (rows[0] ?? null) as RefundLedgerRow | null;

    if (!row) {
      return {
        status: "unknown_purchase",
        reason: "no purchase for this payment intent",
        amountRefundedCents: Number(charge.amount_refunded ?? 0) || 0,
        currency: String(charge.currency ?? ""),
      };
    }

    // 2. What earlier refund events already took back. The ledger is the
    //    authority — replaying an event computes a zero delta.
    const entries = await tx
      .select({ amount: tokenTransactions.amount, type: tokenTransactions.type })
      .from(tokenTransactions)
      .where(
        and(
          eq(tokenTransactions.referenceType, PURCHASE_REFERENCE_TYPE),
          eq(tokenTransactions.referenceId, row.sessionId),
        ),
      );

    const alreadyReversed = (entries as Array<{ amount: unknown; type: string }>)
      .filter((entry) => entry.type === "refund")
      .reduce((sum, entry) => sum + Math.abs(Number(entry.amount) || 0), 0);

    const decision = planCoinRefund(charge, row, alreadyReversed);
    if (!decision.ok) {
      return {
        status: decision.status,
        reason: decision.reason,
        clerkId: row.clerkId,
        packageKey: row.packageKey,
        amountRefundedCents: Number(charge.amount_refunded ?? 0) || 0,
        currency: String(charge.currency ?? row.currency ?? ""),
      };
    }

    const coins = Number(decision.coinsToRevoke);

    // 3. Take the coins back, and only if the wallet still holds them. The
    //    wallet row is locked first, so the balance read here cannot move under
    //    the write; a wallet that cannot cover the reversal is left alone
    //    rather than driven negative.
    const walletRows = await tx
      .select({ balance: users.balance })
      .from(users)
      .where(eq(users.clerkId, row.clerkId))
      .for("update")
      .limit(1);

    const wallet = walletRows[0] ? Number(walletRows[0].balance) : null;
    if (wallet === null || !Number.isFinite(wallet)) {
      return {
        status: "insufficient_balance",
        reason: "buyer's wallet was not found; manual reconciliation required",
        clerkId: row.clerkId,
        coins,
        packageKey: row.packageKey,
        amountRefundedCents: Number(charge.amount_refunded ?? 0) || 0,
        currency: String(charge.currency ?? row.currency ?? ""),
      };
    }
    if (wallet < coins) {
      return {
        status: "insufficient_balance",
        reason: `wallet holds ${wallet} of ${coins} coins; manual reconciliation required`,
        clerkId: row.clerkId,
        coins,
        packageKey: row.packageKey,
        amountRefundedCents: Number(charge.amount_refunded ?? 0) || 0,
        currency: String(charge.currency ?? row.currency ?? ""),
      };
    }

    // An absolute value (not `balance - coins`) because the row is locked above:
    // the read and the write are the same transaction, so nothing can interleave.
    const remaining = Number((wallet - coins).toFixed(2));
    await tx
      .update(users)
      .set({ balance: remaining.toFixed(2) })
      .where(eq(users.clerkId, row.clerkId));

    // 4. Exactly one reversal entry per refund event, in the same transaction
    //    as the debit. Its magnitude is what the next replay reads back.
    await tx.insert(tokenTransactions).values({
      clerkId: row.clerkId,
      type: "refund",
      amount: -coins,
      referenceType: PURCHASE_REFERENCE_TYPE,
      referenceId: row.sessionId,
      note: `stripe-refund:${row.packageKey ?? "package"}:${String(charge.id ?? charge.payment_intent)}`,
    });

    return {
      status: "revoked",
      clerkId: row.clerkId,
      coins,
      balance: remaining,
      packageKey: row.packageKey,
      amountRefundedCents: Number(charge.amount_refunded ?? 0) || 0,
      currency: String(charge.currency ?? row.currency ?? ""),
    };
  });
}
