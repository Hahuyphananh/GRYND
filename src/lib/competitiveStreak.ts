// src/lib/competitiveStreak.ts
//
// THE COMPETITIVE WIN STREAK — ranked human-vs-human only.
//
// This is deliberately SEPARATE from the daily play streak:
//   * the daily streak counts one completed game per UTC day, win or lose;
//   * this counts consecutive WINS in one ranked game (Solitaire Duel and
//     Puzzle Ranked have independent ladders).
//
// It replaces the old `applyLeaderboardCounters` win-streak write, which had no
// callers, ran on its own connection (so it could not roll back with the match)
// and had no per-match idempotency (so a retried settlement would double-count).
//
// SAFETY
//   * runs inside the settlement transaction that decided the match;
//   * the first write is a journal row unique on (match, user, game), so a
//     replayed or concurrent settlement counts once;
//   * only a real ranked human result is recorded — AI, ghosts and guest seats
//     never call this. A draw is a real result here: it resets the current
//     streak to zero, while the personal best is preserved.

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db";
import { userCompetitiveStreaks, users } from "../db/schema";
import {
  COMPETITIVE_STREAK_GAME_KEYS,
  normalizeCompetitiveStreaks,
  type CompetitiveGameKey,
  type CompetitiveStreak,
} from "./competitiveStreakModel";
import { isGuestId } from "./guestIdentity";

export type CompetitiveOutcome = "win" | "loss" | "draw";

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * Record one ranked result for one player.
 *
 * Returns true when this call was the one that counted the match, false when it
 * was a replay or an ineligible seat. A failure throws, exactly like the other
 * settlement writers; callers are already inside the transaction that must be
 * all-or-nothing with the result.
 */
export async function recordCompetitiveResult({
  tx,
  clerkId,
  outcome,
  gameKey,
  matchId,
}: {
  tx: any;
  clerkId: string | null | undefined;
  outcome: CompetitiveOutcome;
  gameKey: string;
  matchId: string | number | null | undefined;
}): Promise<boolean> {
  if (!tx || !clerkId || !gameKey || matchId == null) return false;
  if (isGuestId(clerkId)) return false;
  if (outcome !== "win" && outcome !== "loss" && outcome !== "draw") return false;

  const match = String(matchId);

  // Idempotency gate. The INSERT ... SELECT also proves the user row exists, so
  // a Clerk id with no account writes nothing.
  const inserted = await tx.execute(sql`
    INSERT INTO "competitive_result_events"
      ("match_id", "user_id", "game_key", "outcome")
    SELECT ${match}, u."id", ${gameKey}, ${outcome}
      FROM "users" u
     WHERE u."clerk_id" = ${clerkId}
    ON CONFLICT ("match_id", "user_id", "game_key") DO NOTHING
    RETURNING "user_id"
  `);
  if (rowsOf(inserted).length === 0) return false;

  const isWin = outcome === "win";

  await tx.execute(sql`
    INSERT INTO "user_competitive_streaks"
      ("user_id", "game_key", "current_streak", "best_streak", "last_match_id", "updated_at")
    SELECT u."id", ${gameKey}, ${isWin ? 1 : 0}, ${isWin ? 1 : 0}, ${match}, now()
      FROM "users" u
     WHERE u."clerk_id" = ${clerkId}
    ON CONFLICT ("user_id", "game_key") DO UPDATE SET
      "current_streak" = CASE
        WHEN ${isWin} THEN "user_competitive_streaks"."current_streak" + 1
        ELSE 0
      END,
      "best_streak" = GREATEST(
        "user_competitive_streaks"."best_streak",
        CASE
          WHEN ${isWin} THEN "user_competitive_streaks"."current_streak" + 1
          ELSE "user_competitive_streaks"."best_streak"
        END
      ),
      "last_match_id" = ${match},
      "updated_at" = now()
  `);

  return true;
}

/**
 * Read BOTH ranked ladders for a profile in one query. The result always has a
 * zeroed entry for each supported game key, including players with no row yet.
 * Rows for any other game are discarded by the pure normalizer, so the two
 * formats can never be combined.
 */
export async function readCompetitiveStreaksForClerkId(
  clerkId: string | null | undefined,
  gameKeys: readonly CompetitiveGameKey[] = COMPETITIVE_STREAK_GAME_KEYS,
): Promise<Record<string, CompetitiveStreak>> {
  if (!clerkId || isGuestId(clerkId)) {
    return normalizeCompetitiveStreaks([], gameKeys);
  }

  const rows = await db
    .select({
      gameKey: userCompetitiveStreaks.gameKey,
      current: userCompetitiveStreaks.currentStreak,
      best: userCompetitiveStreaks.bestStreak,
    })
    .from(userCompetitiveStreaks)
    .innerJoin(users, eq(users.id, userCompetitiveStreaks.userId))
    .where(
      and(
        eq(users.clerkId, clerkId),
        inArray(userCompetitiveStreaks.gameKey, [...gameKeys]),
      ),
    );

  return normalizeCompetitiveStreaks(rows, gameKeys);
}

/** The caller's current/best ranked win streak for one game key. */
export async function readCompetitiveStreak({
  tx,
  clerkId,
  gameKey,
}: {
  tx: any;
  clerkId: string | null | undefined;
  gameKey: string;
}): Promise<{ current: number; best: number }> {
  if (!tx || !clerkId || isGuestId(clerkId)) return { current: 0, best: 0 };
  const result = await tx.execute(sql`
    SELECT s."current_streak" AS "current", s."best_streak" AS "best"
      FROM "user_competitive_streaks" s
      JOIN "users" u ON u."id" = s."user_id"
     WHERE u."clerk_id" = ${clerkId} AND s."game_key" = ${gameKey}
     LIMIT 1
  `);
  const row = rowsOf(result)[0];
  return {
    current: Math.max(0, Number(row?.current) || 0),
    best: Math.max(0, Number(row?.best) || 0),
  };
}
