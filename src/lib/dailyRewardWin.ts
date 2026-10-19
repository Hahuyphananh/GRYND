// src/lib/dailyRewardWin.ts
//
// The daily login reward is unlocked by winning a match today. Online results
// were already stamped by the rating writer (src/lib/rating.js) and the PvP
// leaderboard-counter writer (src/lib/leaderboardCounters.js); this helper is
// the same marker for FREE-PLAY wins against the AI, so a practice win counts
// too.
//
// It is deliberately tiny: a settlement path that already knows the winning
// clerk id calls it inside the transaction that flipped the match terminal, and
// the UTC day is written to `users.last_won_game_date`. A bot / guest seat has
// no `users` row, so a win by the bot (or a guest's win) is a harmless no-op —
// callers never have to special-case the AI identity.
//
// A draw must never call this: only a genuine win is the price of the reward.

import { eq } from "drizzle-orm";
import { users } from "../db/schema";

/** The UTC calendar day the `last_won_game_date` DATE column stores. */
export function utcWinDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Stamp today's win for `clerkId` (a winner of a settled match, online or
 * vs-AI). Returns true only when a `users` row actually matched, so a bot seat
 * or an unknown id reports false without failing the settlement.
 */
export async function markDailyRewardWin(
  tx: any,
  clerkId: string | null | undefined
): Promise<boolean> {
  if (!clerkId) return false;
  const updated = await tx
    .update(users)
    .set({ lastWonGameDate: utcWinDay() })
    .where(eq(users.clerkId, String(clerkId)))
    .returning({ id: users.id });
  return Array.isArray(updated) ? updated.length > 0 : Boolean(updated);
}
