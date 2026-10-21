// src/lib/tokens/wager.ts
//
// THE escrow ledger for coin wagers. Every match that moves coins does it
// through these functions, so the rules live in exactly one place:
//
//   * escrowMatchWagers — fund EVERY seat of a match at once (all-or-nothing),
//                     so a staked game is never half-funded.
//   * refundMatchWagers — give every seat's stake back when a match is voided
//                     (cancelled, resigned, never finished, swept away).
//
//   * debitWager    — take the wager on entry (never lets a balance go
//                     negative, never takes the same match's wager twice).
//   * settlePayout  — pay a winner on settle, capped by MAX_WIN_PER_MATCH and
//                     never paid twice for the same match.
//   * refundWager   — give a wager back when a match is voided / never starts.
//
// The terminal moves are mutually exclusive per match: a payout requires the
// `wager` debit row that funded it, a refund is refused once that match's seat
// was PAID, and a payout is refused once the stake was given BACK. So no path
// can mint coins, hand a stake back to someone who already won on it, or pay a
// winner out of money the house returned.
//
// Idempotency is enforced with the ledger itself: each move writes one
// `token_transactions` row keyed `(reference_type, reference_id)` where the
// reference id is `<matchId>:<clerkId>`. Every move first takes a
// `SELECT … FOR UPDATE` lock on the player's row, so two concurrent settles for
// the same player serialise and the second one sees the first one's row and
// does nothing.
//
// Call these with the SAME transaction the caller uses to write its match row
// (`tx`), so the balance move commits with the result that caused it.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { tokenTransactions, users } from "../../db/schema";
import { MAX_WIN_PER_MATCH } from "../games/economy";

/**
 * The executor is either the shared `db` or a transaction (`tx`) created by
 * `db.transaction(...)`. Typed loosely on purpose — same rationale as
 * src/lib/tokens/creditTokens.ts: both expose the same chained
 * `.select().for("update") / .update().set() / .insert()` shape, and the escrow
 * caller must be able to pass whichever one it holds.
 */
type LedgerTx = any;

export type WagerMove =
  | { ok: true; balance: number; applied: boolean }
  | { ok: false; error: string; status: number; code?: string };

/** Ledger reference types. One per kind of balance move a match makes. */
export const WAGER_REFERENCE = "wager";
export const PAYOUT_REFERENCE = "payout";
export const REFUND_REFERENCE = "wager-refund";

/** `token_transactions.reference_id` for one player's move in one match. */
export function wagerLedgerKey(matchId: unknown, clerkId: string): string {
  return `${String(matchId)}:${clerkId}`;
}

/**
 * The most a single payout may credit: the requested amount, floored at
 * `MAX_WIN_PER_MATCH`. The player's current balance plays no part — there is no
 * wallet ceiling, so a wallet already holding more than any round number still
 * receives a legitimate payout in full. Pure, so the ceiling is unit-testable
 * without a database.
 */
export function capPayout(amount: number): number {
  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(requested, MAX_WIN_PER_MATCH);
}

/** Has this exact move for this match already been written? */
async function ledgerRowExists(
  tx: LedgerTx,
  referenceType: string,
  referenceId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: tokenTransactions.id })
    .from(tokenTransactions)
    .where(
      and(
        eq(tokenTransactions.referenceType, referenceType),
        eq(tokenTransactions.referenceId, referenceId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Lock (and read) the player's row inside the caller's transaction. */
async function lockUser(tx: LedgerTx, clerkId: string) {
  const [row] = await tx
    .select({ id: users.id, balance: users.balance })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .for("update");
  return row ?? null;
}

async function writeLedger(
  tx: LedgerTx,
  {
    clerkId,
    type,
    amount,
    referenceType,
    referenceId,
    note,
  }: {
    clerkId: string;
    type: "spend" | "reward" | "refund";
    amount: number;
    referenceType: string;
    referenceId: string;
    note?: string | null;
  },
) {
  await tx.insert(tokenTransactions).values({
    clerkId,
    type,
    amount,
    referenceType,
    referenceId,
    note: note ?? null,
  });
}

/**
 * Escrow every seat of a match at once, all-or-nothing.
 *
 * Locks the seats in Clerk-id order (so two matches can never deadlock),
 * checks each one can cover the wager, and only then debits. A seat that could
 * not afford it leaves EVERY seat untouched, so a match is never half-funded —
 * and a seat that already has a wager row for this match (a retry) is skipped
 * rather than charged twice.
 */
export async function escrowMatchWagers({
  clerkIds,
  stake,
  matchId,
  gameKey,
  tx = db,
}: {
  clerkIds: (string | null | undefined)[];
  stake: number;
  matchId: unknown;
  gameKey?: string;
  tx?: LedgerTx;
}): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const amount = Number(stake);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: true }; // free match

  const seats = [...new Set(clerkIds.filter((id): id is string => Boolean(id)))].sort();
  if (seats.length === 0) return { ok: true };

  const rows = await tx
    .select({ clerkId: users.clerkId, balance: users.balance })
    .from(users)
    .where(inArray(users.clerkId, seats))
    .for("update");
  const balanceBy = new Map<string, number>();
  for (const row of rows as any[]) {
    balanceBy.set(String(row.clerkId), Number(row.balance ?? 0));
  }

  const toCharge: string[] = [];
  for (const clerkId of seats) {
    const balance = balanceBy.get(clerkId);
    if (balance === undefined) {
      return { ok: false, error: "User not found", status: 404 };
    }
    const referenceId = wagerLedgerKey(matchId, clerkId);
    if (await ledgerRowExists(tx, WAGER_REFERENCE, referenceId)) continue;
    if (balance < amount) {
      return { ok: false, error: "Insufficient coins", status: 400 };
    }
    toCharge.push(clerkId);
  }

  for (const clerkId of toCharge) {
    const result = await debitWager({ clerkId, stake: amount, matchId, gameKey, tx });
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Give every seat's escrow back at once — a voided match (resigned, torn down,
 * or reclaimed as abandoned). Each refund is independent and `refundWager`
 * itself skips a seat that was never charged (and one that was already PAID),
 * so calling this on a free, half-funded or settled match is safe.
 */
export async function refundMatchWagers({
  clerkIds,
  stake,
  matchId,
  gameKey,
  tx = db,
}: {
  clerkIds: (string | null | undefined)[];
  stake: number;
  matchId: unknown;
  gameKey?: string;
  tx?: LedgerTx;
}): Promise<{ ok: true; refunded: number }> {
  const amount = Number(stake);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: true, refunded: 0 };

  const seats = [...new Set(clerkIds.filter((id): id is string => Boolean(id)))].sort();
  let refunded = 0;
  for (const clerkId of seats) {
    // Annotated rather than inferred: `strict` is off in this project, where a
    // discriminated union is not narrowed by `if (!x.ok)` (same reason the
    // tower-arena escrow call site types its result explicitly).
    const result: { ok: boolean; error?: string; applied?: boolean } =
      await refundWager({ clerkId, stake: amount, matchId, gameKey, tx });
    if (!result.ok) {
      // A seat we cannot credit is worth shouting about: the stake stays
      // escrowed and nothing else will ever look at this match again.
      console.error(
        `[wager] refund failed for ${clerkId} on ${String(matchId)}: ${result.error}`,
      );
      continue;
    }
    if (result.applied) refunded += 1;
  }
  return { ok: true, refunded };
}

/**
 * Take a wager out of a player's balance for a match.
 *
 * A zero / absent stake is a free match: nothing moves and nothing is written.
 * Returns `INSUFFICIENT_BALANCE` rather than letting the balance go negative.
 */
export async function debitWager({
  clerkId,
  stake,
  matchId,
  gameKey,
  note,
  tx = db,
}: {
  clerkId: string;
  stake: number;
  matchId: unknown;
  gameKey?: string;
  note?: string | null;
  tx?: LedgerTx;
}): Promise<WagerMove> {
  const amount = Number(stake);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Invalid wager", status: 400 };
  }
  const user = await lockUser(tx, clerkId);
  if (!user) return { ok: false, error: "User not found", status: 404 };
  const balance = Number(user.balance ?? 0);

  if (amount === 0) return { ok: true, balance, applied: false };

  const referenceId = wagerLedgerKey(matchId, clerkId);
  if (await ledgerRowExists(tx, WAGER_REFERENCE, referenceId)) {
    return { ok: true, balance, applied: false };
  }
  if (balance < amount) {
    return {
      ok: false,
      error: "Insufficient coins",
      status: 400,
      code: "INSUFFICIENT_BALANCE",
    };
  }

  const [updated] = await tx
    .update(users)
    .set({
      balance: sql`${users.balance} - ${amount}`,
      totalWagered: sql`${users.totalWagered} + ${amount}`,
      dailyWagered: sql`${users.dailyWagered} + ${amount}`,
      weeklyWagered: sql`${users.weeklyWagered} + ${amount}`,
    })
    .where(eq(users.id, user.id))
    .returning({ balance: users.balance });

  await writeLedger(tx, {
    clerkId,
    type: "spend",
    amount: -amount,
    referenceType: WAGER_REFERENCE,
    referenceId,
    note: note ?? gameKey ?? null,
  });

  return { ok: true, balance: Number(updated.balance), applied: true };
}

/**
 * Pay a winner for a settled match. The credit is capped by
 * `MAX_WIN_PER_MATCH` only (see `capPayout`), and the move is written once per
 * match however many times settlement is retried.
 */
export async function settlePayout({
  clerkId,
  amount,
  matchId,
  gameKey,
  note,
  tx = db,
}: {
  clerkId: string;
  amount: number;
  matchId: unknown;
  gameKey?: string;
  note?: string | null;
  tx?: LedgerTx;
}): Promise<WagerMove> {
  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested < 0) {
    return { ok: false, error: "Invalid payout", status: 400 };
  }
  const user = await lockUser(tx, clerkId);
  if (!user) return { ok: false, error: "User not found", status: 404 };
  const balance = Number(user.balance ?? 0);

  const referenceId = wagerLedgerKey(matchId, clerkId);
  if (await ledgerRowExists(tx, PAYOUT_REFERENCE, referenceId)) {
    return { ok: true, balance, applied: false };
  }
  // A payout must be funded: without the matching debit row ("wager") the
  // credit would MINT coins — e.g. settling a row created before wagering
  // returned, or a match whose escrow was never taken. The safe failure mode
  // is to pay nothing (the match was effectively free), never to invent coins.
  if (!(await ledgerRowExists(tx, WAGER_REFERENCE, referenceId))) {
    return { ok: true, balance, applied: false };
  }
  // …and a VOIDED match pays nobody: once a stake has been given back, a payout
  // on the same match would pay the winner out of money the house already
  // returned (the mirror of the refund guard below). Two terminal paths racing
  // on one match therefore cannot both move coins.
  if (await ledgerRowExists(tx, REFUND_REFERENCE, referenceId)) {
    return { ok: true, balance, applied: false };
  }

  const credit = capPayout(requested);
  let newBalance = balance;
  if (credit > 0) {
    const [updated] = await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${credit}`,
        peakBalance: sql`GREATEST(${users.peakBalance}, ${users.balance} + ${credit})`,
        totalWon: sql`${users.totalWon} + ${credit}`,
        dailyWon: sql`${users.dailyWon} + ${credit}`,
        weeklyWon: sql`${users.weeklyWon} + ${credit}`,
        // Monotonic high-water mark — drives the "Biggest coin win" board.
        biggestWin: sql`GREATEST(${users.biggestWin}, ${Math.round(credit)})`,
      })
      .where(eq(users.id, user.id))
      .returning({ balance: users.balance });
    newBalance = Number(updated.balance);
  }

  // Written even for a 0-amount payout so a retry is recognised: the row is the
  // idempotency key, not the amount.
  await writeLedger(tx, {
    clerkId,
    type: "reward",
    amount: credit,
    referenceType: PAYOUT_REFERENCE,
    referenceId,
    note: note ?? gameKey ?? null,
  });

  return { ok: true, balance: newBalance, applied: credit > 0 };
}

/**
 * Give a wager back — a cancelled lobby, a voided match, or the losing side of
 * a match that never started. Always the full stake: it is the player's own
 * coins coming back, not a win.
 */
export async function refundWager({
  clerkId,
  stake,
  matchId,
  gameKey,
  note,
  tx = db,
}: {
  clerkId: string;
  stake: number;
  matchId: unknown;
  gameKey?: string;
  note?: string | null;
  tx?: LedgerTx;
}): Promise<WagerMove> {
  const requested = Number(stake);
  if (!Number.isFinite(requested) || requested < 0) {
    return { ok: false, error: "Invalid refund", status: 400 };
  }
  const user = await lockUser(tx, clerkId);
  if (!user) return { ok: false, error: "User not found", status: 404 };
  const balance = Number(user.balance ?? 0);

  if (requested === 0) return { ok: true, balance, applied: false };

  const referenceId = wagerLedgerKey(matchId, clerkId);
  if (await ledgerRowExists(tx, REFUND_REFERENCE, referenceId)) {
    return { ok: true, balance, applied: false };
  }
  // Never refund a stake that was never taken: without the matching debit row
  // ("wager") the refund would MINT coins — e.g. cancelling a free lobby, or
  // refunding a seat that joined after the wager was already settled.
  if (!(await ledgerRowExists(tx, WAGER_REFERENCE, referenceId))) {
    return { ok: true, balance, applied: false };
  }
  // …and never refund a seat that was already PAID for this match: a payout
  // plus a refund of the same stake would credit it twice. Same rule as the
  // funding check above, from the other side.
  if (await ledgerRowExists(tx, PAYOUT_REFERENCE, referenceId)) {
    return { ok: true, balance, applied: false };
  }

  // A refund returns coins the player already had (the matching debit row is
  // required above), so it is paid in full: `MAX_WIN_PER_MATCH` bounds winnings,
  // never a stake coming back.
  const credit = requested;
  let newBalance = balance;
  if (credit > 0) {
    const [updated] = await tx
      .update(users)
      .set({
        balance: sql`${users.balance} + ${credit}`,
        peakBalance: sql`GREATEST(${users.peakBalance}, ${users.balance} + ${credit})`,
      })
      .where(eq(users.id, user.id))
      .returning({ balance: users.balance });
    newBalance = Number(updated.balance);
  }

  await writeLedger(tx, {
    clerkId,
    type: "refund",
    amount: credit,
    referenceType: REFUND_REFERENCE,
    referenceId,
    note: note ?? gameKey ?? null,
  });

  return { ok: true, balance: newBalance, applied: credit > 0 };
}
