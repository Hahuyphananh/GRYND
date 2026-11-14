// src/lib/solitaire-duel/analysisAllowance.ts
//
// THE GAME REVIEW ALLOWANCE — 3 fresh analyses per UTC day on the free plan,
// unlimited for GRYND PRO. Server-authoritative, per identity, never client
// supplied.
//
// WHAT COSTS AN ANALYSIS. Only a CACHE MISS. The analysis of a game is
// deterministic and cached by (game, canonical log digest, engine version), so
// re-opening a game that has already been analysed — after a refresh, on a
// second device, from the post-match review button — costs nothing and must not
// count against the day. `reviewAnalysis.ts` asks this module only after the
// cache has come back empty.
//
// WHY A TABLE. The count must survive a restart and be shared by every server
// instance, so it lives in `solitaire_analysis_usage` (one row per identity per
// UTC day). An in-process counter would reset on deploy and multiply by
// instance count — a free account could then analyse without limit.
//
// THE INCREMENT IS ATOMIC. `consume` is a single INSERT … ON CONFLICT DO UPDATE
// … WHERE used < limit … RETURNING: two concurrent first views of two different
// games cannot both take the last slot, and no read-then-write race can exceed
// the limit. A denied consume returns no row and changes nothing.
//
// PRO IS NEVER COUNTED. `getMembershipTier(userId) === "pro"` is the same
// server-side source the ad entitlement uses; a PRO member skips the table
// entirely, so their allowance can never be exhausted.
//
// FAILURE POLICY — FAILS OPEN (an analysis may be granted).
// If the usage table cannot be read or written, the review still computes: the
// cache and the game itself are unaffected, and refusing a member their review
// because a quota row is unreachable is the worse failure. The exposure is
// bounded to the duration of the incident.

import { sql } from "drizzle-orm";

import { db } from "../../db/client";

/** Fresh (cache-miss) analyses a free account gets per UTC day. */
export const FREE_ANALYSES_PER_DAY = 3;

/** The UTC calendar day an allowance belongs to (`YYYY-MM-DD`). */
export function analysisDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The instant the allowance resets: the next UTC midnight. */
export function analysisResetAt(now: Date = new Date()): string {
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return new Date(reset).toISOString();
}

/** What a client may show about the allowance. Numbers only, never a token. */
export type AnalysisAllowance = {
  /** True for GRYND PRO: no limit, nothing counted. */
  readonly unlimited: boolean;
  /** Free-plan limit, or null when unlimited. */
  readonly limit: number | null;
  /** Fresh analyses already consumed today (0 when unlimited). */
  readonly used: number;
  /** Analyses left today, or null when unlimited. */
  readonly remaining: number | null;
  /** UTC day the count belongs to. */
  readonly dayKey: string;
  /** ISO instant the count resets. */
  readonly resetsAt: string;
};

export function unlimitedAllowance(now: Date = new Date()): AnalysisAllowance {
  return {
    unlimited: true,
    limit: null,
    used: 0,
    remaining: null,
    dayKey: analysisDayKey(now),
    resetsAt: analysisResetAt(now),
  };
}

export function freeAllowance(
  used: number,
  now: Date = new Date(),
): AnalysisAllowance {
  const safe = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
  return {
    unlimited: false,
    limit: FREE_ANALYSES_PER_DAY,
    used: safe,
    remaining: Math.max(0, FREE_ANALYSES_PER_DAY - safe),
    dayKey: analysisDayKey(now),
    resetsAt: analysisResetAt(now),
  };
}

/** Node-postgres returns `{ rows }`; a driver may return the array directly. */
function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const rows = (result as { rows?: unknown }).rows ?? result;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

/** Read today's consumed count. A missing row is 0. */
export async function readAnalysisUsage({
  playerId,
  dayKey,
}: {
  playerId: string;
  dayKey: string;
}): Promise<number> {
  const result = await db.execute(sql`
    select "used" from "solitaire_analysis_usage"
     where "user_id" = ${playerId} and "day_key" = ${dayKey}
     limit 1
  `);
  const used = Number(firstRow(result)?.used);
  return Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
}

/**
 * Take one fresh analysis from today's allowance.
 *
 * Returns the new consumed count, or null when the free allowance is already
 * spent (nothing was written in that case). One statement: the limit check and
 * the increment cannot be split by a concurrent request.
 */
export async function consumeAnalysisUsage({
  playerId,
  dayKey,
  limit = FREE_ANALYSES_PER_DAY,
}: {
  playerId: string;
  dayKey: string;
  limit?: number;
}): Promise<number | null> {
  const result = await db.execute(sql`
    insert into "solitaire_analysis_usage" ("user_id", "day_key", "used", "updated_at")
    values (${playerId}, ${dayKey}, 1, now())
    on conflict ("user_id", "day_key") do update
       set "used" = "solitaire_analysis_usage"."used" + 1,
           "updated_at" = now()
     where "solitaire_analysis_usage"."used" < ${limit}
    returning "used"
  `);
  const used = Number(firstRow(result)?.used);
  return Number.isFinite(used) && used > 0 ? Math.floor(used) : null;
}

export type AnalysisAllowanceDeps = {
  readUsage?: typeof readAnalysisUsage;
  consumeUsage?: typeof consumeAnalysisUsage;
};

/** Today's allowance for a viewer, without consuming anything. */
export async function readAnalysisAllowance(
  {
    playerId,
    isPro,
    now = new Date(),
  }: { playerId: string; isPro: boolean; now?: Date },
  deps: AnalysisAllowanceDeps = {},
): Promise<AnalysisAllowance> {
  if (isPro) return unlimitedAllowance(now);
  const dayKey = analysisDayKey(now);
  try {
    const used = await (deps.readUsage ?? readAnalysisUsage)({ playerId, dayKey });
    return freeAllowance(used, now);
  } catch {
    // Unreachable quota table: report a full allowance rather than invent a
    // spent one (the review itself still runs — see the module note).
    return freeAllowance(0, now);
  }
}

/**
 * Consume one fresh analysis, or deny it.
 *
 * `allowed` is false only when the store ANSWERED that the day's limit is
 * spent. An infrastructure error fails open (allowed, nothing counted).
 */
export async function consumeAnalysisAllowance(
  {
    playerId,
    isPro,
    now = new Date(),
  }: { playerId: string; isPro: boolean; now?: Date },
  deps: AnalysisAllowanceDeps = {},
): Promise<{ allowed: boolean; allowance: AnalysisAllowance }> {
  if (isPro) return { allowed: true, allowance: unlimitedAllowance(now) };

  const dayKey = analysisDayKey(now);
  try {
    const used = await (deps.consumeUsage ?? consumeAnalysisUsage)({ playerId, dayKey });
    if (used !== null) return { allowed: true, allowance: freeAllowance(used, now) };

    // No row came back. That is the denial path, but confirm the count is really
    // at the limit before refusing: a driver/store that answers without a row
    // (rather than with one) must not silently spend someone's day. Only a
    // confirmed full count denies.
    const counted = await (deps.readUsage ?? readAnalysisUsage)({ playerId, dayKey });
    if (counted >= FREE_ANALYSES_PER_DAY) {
      return { allowed: false, allowance: freeAllowance(counted, now) };
    }
    return { allowed: true, allowance: freeAllowance(counted, now) };
  } catch {
    return { allowed: true, allowance: freeAllowance(0, now) };
  }
}
