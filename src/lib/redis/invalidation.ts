import { cacheDelete, cacheDeletePattern } from "./cache";
import { CacheKeys } from "./keys";

/**
 * Invalidation Events
 *
 * These are the event-driven invalidation primitives.
 * Call them at the right moment in game settlement / stat update flows
 * to ensure cached data stays fresh without waiting for TTL expiry.
 *
 * Primary invalidation strategy: these events
 * Backup strategy: TTL expiry (configured in keys.ts)
 */

/**
 * Invalidate ALL leaderboard caches.
 *
 * Call this whenever ANY game is settled and leaderboard stats change:
 * - after leaderboardCounters (game settlement)
 * - after weekly reset
 * - after bet settlement
 *
 * We invalidate ALL leaderboard keys (all-time + weekly + wins + streaks)
 * because a single game can affect every leaderboard category.
 */
export async function invalidateAllLeaderboards(): Promise<void> {
  await cacheDeletePattern(CacheKeys.leaderboard.all);
}

/**
 * Invalidate a specific user's stats cache.
 *
 * Call this after any operation that changes that user's stats or bet history.
 */
export async function invalidateUserStats(clerkId: string): Promise<void> {
  await cacheDelete(CacheKeys.userStats(clerkId));
}

/**
 * Invalidate the recent games feed.
 *
 * Call this after any new game is recorded.
 */
export async function invalidateRecentGames(): Promise<void> {
  await cacheDeletePattern(CacheKeys.recentGamesAll);
}

/**
 * Invalidate the big wins feed.
 *
 * Call this after a new big win (10x+ multiplier) is recorded.
 */
export async function invalidateBigWins(): Promise<void> {
  await cacheDeletePattern(CacheKeys.bigWinsAll);
}

/**
 * Full invalidation for a game settlement event.
 *
 * Call this once after a bet is settled or a game completes.
 * Handles all relevant caches in a single call.
 */
export async function invalidateOnGameSettlement(
  clerkId?: string,
): Promise<void> {
  // Fire all invalidations in parallel (don't await individually,
  // but we await the whole block so the caller knows when done)
  await Promise.allSettled([
    invalidateAllLeaderboards(),
    invalidateRecentGames(),
    clerkId ? invalidateUserStats(clerkId) : Promise.resolve(),
  ]);
}
