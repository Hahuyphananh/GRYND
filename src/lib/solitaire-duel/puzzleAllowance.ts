// src/lib/solitaire-duel/puzzleAllowance.ts
//
// THE UNLIMITED PUZZLE ALLOWANCE — 5 puzzles per UTC day on the free plan,
// unlimited for GRYND PRO. Server-authoritative, per identity, never client
// supplied.
//
// The DAILY puzzle is deliberately NOT counted: it is free for everyone and can
// be played exactly once a day (enforced by the attempt table's unique key in
// the route, not by this quota).
//
// WHY A TABLE: the count must survive a restart and be shared by every server
// instance, so it lives in `solitaire_puzzle_usage` (one row per identity per
// UTC day). An in-process counter would reset on deploy and multiply by
// instance count.
//
// THE INCREMENT IS ATOMIC: `consume` is a single INSERT … ON CONFLICT DO UPDATE
// … WHERE used < limit … RETURNING, so two concurrent submissions cannot both
// take the last slot.
//
// PRO IS NEVER COUNTED. `getMembershipTier(userId) === "pro"` is the same
// server-side entitlement every other PRO perk uses; a member skips the table.
//
// FAILURE POLICY — FAILS OPEN. If the usage table cannot be read or written the
// puzzle is still granted. A brief outage must not make a free player's puzzle
// unavailable, and the exposure is bounded to the incident (matching the Game
// Review allowance).

import { sql } from "drizzle-orm";

import { db } from "../../db/client";

/** Unlimited puzzles a free account gets per UTC day. */
export const FREE_PUZZLES_PER_DAY = 5;

/** The UTC calendar day an allowance belongs to (`YYYY-MM-DD`). */
export function puzzleDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The instant the allowance resets: the next UTC midnight. */
export function puzzleResetAt(now: Date = new Date()): string {
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return new Date(reset).toISOString();
}

/** What a client may show about the allowance. Numbers only, never a token. */
export type PuzzleAllowance = {
  /** True for GRYND PRO: no limit, nothing counted. */
  readonly unlimited: boolean;
  /** Free-plan limit, or null when unlimited. */
  readonly limit: number | null;
  /** Unlimited puzzles answered today (0 when unlimited). */
  readonly used: number;
  /** Puzzles left today, or null when unlimited. */
  readonly remaining: number | null;
  /** UTC day the count belongs to. */
  readonly dayKey: string;
  /** ISO instant the count resets. */
  readonly resetsAt: string;
};

export function unlimitedPuzzleAllowance(now: Date = new Date()): PuzzleAllowance {
  return {
    unlimited: true,
    limit: null,
    used: 0,
    remaining: null,
    dayKey: puzzleDayKey(now),
    resetsAt: puzzleResetAt(now),
  };
}

export function freePuzzleAllowance(
  used: number,
  now: Date = new Date(),
): PuzzleAllowance {
  const safe = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  return {
    unlimited: false,
    limit: FREE_PUZZLES_PER_DAY,
    used: safe,
    remaining: Math.max(0, FREE_PUZZLES_PER_DAY - safe),
    dayKey: puzzleDayKey(now),
    resetsAt: puzzleResetAt(now),
  };
}

/** Node-postgres returns `{ rows }`; a driver may return the array directly. */
function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const rows = (result as { rows?: unknown }).rows ?? result;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

/** Read today's consumed count. A missing row is 0. */
export async function readPuzzleUsage({
  playerId,
  dayKey,
}: {
  playerId: string;
  dayKey: string;
}): Promise<number> {
  const result = await db.execute(sql`
    select "used" from "solitaire_puzzle_usage"
     where "user_id" = ${playerId} and "day_key" = ${dayKey}
     limit 1
  `);
  const used = Number(firstRow(result)?.used);
  return Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
}

/**
 * Take one puzzle from today's allowance.
 *
 * Returns the new consumed count, or null when the free allowance is spent
 * (nothing was written in that case).
 */
export async function consumePuzzleUsage({
  playerId,
  dayKey,
  limit = FREE_PUZZLES_PER_DAY,
}: {
  playerId: string;
  dayKey: string;
  limit?: number;
}): Promise<number | null> {
  const result = await db.execute(sql`
    insert into "solitaire_puzzle_usage" ("user_id", "day_key", "used", "updated_at")
    values (${playerId}, ${dayKey}, 1, now())
    on conflict ("user_id", "day_key") do update
       set "used" = "solitaire_puzzle_usage"."used" + 1,
           "updated_at" = now()
     where "solitaire_puzzle_usage"."used" < ${limit}
    returning "used"
  `);
  const used = Number(firstRow(result)?.used);
  return Number.isFinite(used) && used > 0 ? Math.floor(used) : null;
}

export type PuzzleAllowanceDeps = {
  readUsage?: typeof readPuzzleUsage;
  consumeUsage?: typeof consumePuzzleUsage;
};

/** Today's allowance for a viewer, without consuming anything. */
export async function readPuzzleAllowance(
  {
    playerId,
    isPro,
    now = new Date(),
  }: { playerId: string; isPro: boolean; now?: Date },
  deps: PuzzleAllowanceDeps = {},
): Promise<PuzzleAllowance> {
  if (isPro) return unlimitedPuzzleAllowance(now);
  const dayKey = puzzleDayKey(now);
  try {
    const used = await (deps.readUsage ?? readPuzzleUsage)({ playerId, dayKey });
    return freePuzzleAllowance(used, now);
  } catch {
    // Unreachable quota table: report a full allowance rather than a spent one.
    return freePuzzleAllowance(0, now);
  }
}

/**
 * Consume one unlimited puzzle, or deny it.
 *
 * `allowed` is false only when the store ANSWERED that the day's limit is spent.
 * An infrastructure error fails open (allowed, nothing counted).
 */
export async function consumePuzzleAllowance(
  {
    playerId,
    isPro,
    now = new Date(),
  }: { playerId: string; isPro: boolean; now?: Date },
  deps: PuzzleAllowanceDeps = {},
): Promise<{ allowed: boolean; allowance: PuzzleAllowance }> {
  if (isPro) return { allowed: true, allowance: unlimitedPuzzleAllowance(now) };

  const dayKey = puzzleDayKey(now);
  try {
    const used = await (deps.consumeUsage ?? consumePuzzleUsage)({ playerId, dayKey });
    if (used !== null) return { allowed: true, allowance: freePuzzleAllowance(used, now) };

    // No row came back: confirm the count is really at the limit before
    // refusing, so a store that answers without a row cannot spend someone's day.
    const counted = await (deps.readUsage ?? readPuzzleUsage)({ playerId, dayKey });
    if (counted >= FREE_PUZZLES_PER_DAY) {
      return { allowed: false, allowance: freePuzzleAllowance(counted, now) };
    }
    return { allowed: true, allowance: freePuzzleAllowance(counted, now) };
  } catch {
    return { allowed: true, allowance: freePuzzleAllowance(0, now) };
  }
}
