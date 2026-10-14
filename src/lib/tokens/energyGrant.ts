// src/lib/tokens/energyGrant.ts
//
// The two faucets that create coins for free — and nothing else does.
//
//   1. The DAILY ENERGY GRANT. Coins are an energy currency: a player below
//      `ENERGY_GRANT_FLOOR` is topped up to it, at most once per UTC day, by at
//      most `DAILY_ENERGY_GRANT`. A player at or above the floor gets nothing,
//      so the grant can never be farmed above it and a balance cannot grow
//      without winning.
//
//   2. The ZERO-BALANCE RESCUE. A player whose wallet is empty is topped up to
//      `ZERO_BALANCE_RESCUE` (10 tokens) so they always have one more game in
//      them, at most once per UTC day. It is deliberately tiny and deliberately
//      SECOND: because the energy grant is claimed first on the same read, the
//      rescue can only fire once the day's granted allowance has already been
//      spent — it is a floor of "one last wager", never a second allowance.
//
// Idempotency is the ledger itself: each move writes one `token_transactions`
// row keyed `(reference_type, reference_id)` = `("energy-grant"|"rescue-grant",
// "<utc-day>:<clerkId>")`. A second call on the same day sees that row and does
// nothing, so the route that reads the balance can call both on every request.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { tokenTransactions, users } from "../../db/schema";
import {
  DAILY_ENERGY_GRANT,
  ENERGY_GRANT_FLOOR,
  WALLET_HARD_CAP,
  ZERO_BALANCE_RESCUE,
} from "../games/economy";

export const ENERGY_GRANT_REFERENCE = "energy-grant";

export const RESCUE_GRANT_REFERENCE = "rescue-grant";

/** The UTC calendar day a grant belongs to (`YYYY-MM-DD`). */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * How many coins the grant should add to `balance`: 0 at or above the floor
 * (or for an unusable balance), otherwise the shortfall up to the floor,
 * never more than the daily cap. Pure, so the ceiling is unit-testable.
 */
export function energyGrantAmount(
  balance: number,
  floor: number = ENERGY_GRANT_FLOOR,
  grant: number = DAILY_ENERGY_GRANT,
): number {
  const current = Number(balance);
  if (!Number.isFinite(current) || current >= floor) return 0;
  const shortfall = Math.max(0, floor - current);
  return Math.max(0, Math.min(grant, shortfall));
}

/**
 * How many coins the zero-balance rescue should add to `balance`: nothing at
 * all for a wallet that still has something in it, otherwise the shortfall up
 * to `ZERO_BALANCE_RESCUE`, and never more than that. Pure, so the "one last
 * game, never an income" ceiling is unit-testable.
 */
export function rescueGrantAmount(
  balance: number,
  rescue: number = ZERO_BALANCE_RESCUE,
): number {
  const current = Number(balance);
  if (!Number.isFinite(current) || current > 0) return 0;
  // `current <= 0` — an empty (or, impossibly, negative) wallet is topped up
  // to the rescue amount, clamped so a debt is never repaid beyond it.
  return Math.max(0, Math.min(rescue, rescue - current));
}

export type EnergyGrantResult =
  | { ok: true; granted: number; balance: number }
  | { ok: false; error: string; status: number };

/**
 * Top the player up for today if they are below the floor and have not already
 * been topped up today. Safe to call on every balance read.
 */
export async function claimEnergyGrant(
  clerkId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<EnergyGrantResult> {
  if (!clerkId) return { ok: false, error: "Missing user", status: 400 };

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, balance: users.balance })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .for("update");
    if (!user) return { ok: false, error: "User not found", status: 404 };

    const balance = Number(user.balance ?? 0);
    const amount = energyGrantAmount(balance);
    if (amount <= 0) return { ok: true, granted: 0, balance };

    const referenceId = `${utcDayKey(now)}:${clerkId}`;
    const existing = await tx
      .select({ id: tokenTransactions.id })
      .from(tokenTransactions)
      .where(
        and(
          eq(tokenTransactions.referenceType, ENERGY_GRANT_REFERENCE),
          eq(tokenTransactions.referenceId, referenceId),
        ),
      )
      .limit(1);
    if (existing.length > 0) return { ok: true, granted: 0, balance };

    // Same wallet ceiling as every other credit.
    const credit = Math.min(amount, Math.max(0, WALLET_HARD_CAP - balance));

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

    // Written even for a capped-to-0 credit so the day is still marked.
    await tx.insert(tokenTransactions).values({
      clerkId,
      type: "reward",
      amount: credit,
      referenceType: ENERGY_GRANT_REFERENCE,
      referenceId,
      note: "Daily energy grant",
    });

    return { ok: true, granted: credit, balance: newBalance };
  });
}

/**
 * Give a broke player one last game: top an EMPTY wallet up to
 * `ZERO_BALANCE_RESCUE` (10 tokens), at most once per UTC day. Safe to call on
 * every balance read — idempotent through the ledger, exactly like the energy
 * grant — and a no-op for any wallet that still has coins in it.
 *
 * Called AFTER `claimEnergyGrant` so the day's real allowance always wins: the
 * rescue is the floor beneath it, not a second helping.
 */
export async function claimZeroBalanceRescue(
  clerkId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<EnergyGrantResult> {
  if (!clerkId) return { ok: false, error: "Missing user", status: 400 };

  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, balance: users.balance })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .for("update");
    if (!user) return { ok: false, error: "User not found", status: 404 };

    const balance = Number(user.balance ?? 0);
    const amount = rescueGrantAmount(balance);
    if (amount <= 0) return { ok: true, granted: 0, balance };

    const referenceId = `${utcDayKey(now)}:${clerkId}`;
    const existing = await tx
      .select({ id: tokenTransactions.id })
      .from(tokenTransactions)
      .where(
        and(
          eq(tokenTransactions.referenceType, RESCUE_GRANT_REFERENCE),
          eq(tokenTransactions.referenceId, referenceId),
        ),
      )
      .limit(1);
    if (existing.length > 0) return { ok: true, granted: 0, balance };

    // Same wallet ceiling as every other credit.
    const credit = Math.min(amount, Math.max(0, WALLET_HARD_CAP - balance));

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

    // Written even for a capped-to-0 credit so the day is still marked.
    await tx.insert(tokenTransactions).values({
      clerkId,
      type: "reward",
      amount: credit,
      referenceType: RESCUE_GRANT_REFERENCE,
      referenceId,
      note: "Zero-balance rescue — one last game",
    });

    return { ok: true, granted: credit, balance: newBalance };
  });
}
