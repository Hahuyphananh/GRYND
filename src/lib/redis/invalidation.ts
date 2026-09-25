import { cacheDelete, cacheDeletePattern } from "./cache";
import { withRedis } from "./client";
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
 * Round-trip per-instance lock window for debounced leaderboard invalidation.
 *
 * When many games settle back-to-back (high-traffic burst), each one used to
 * wipe the ENTIRE leaderboard cache, forcing the next few leaderboard reads
 * to recompute the full-table sort again and again (a stampede). Debouncing
 * collapses all settlements within a window into at most one purge. The
 * leaderboard *reads* carry a per-key TTL (5 min), so a 60s debounce keeps
 * the public ranking fresh enough while avoiding the stampede.
 */
export const LEADERBOARD_DEBOUNCE_SECONDS = 60;

/**
 * Invalidate ALL leaderboard caches immediately (including per-game boards).
 *
 * Used by flows that MUST be instantly fresh (the weekly reset and admin
 * cache-flush), where a stale ranking would be user-visible and misleading.
 */
export async function invalidateAllLeaderboards(): Promise<void> {
  await cacheDeletePattern(CacheKeys.leaderboard.all);
}

/**
 * Purge the ranking boards every settlement can affect (all-time, weekly,
 * wins, daily-streak). Per-game boards are deliberately excluded: a board
 * for game X only changes when game X is played, so unrelated settlements
 * must not force its full-table aggregate to recompute. It refreshes on its
 * own read TTL instead.
 */
async function purgeLeaderboardRankings(): Promise<void> {
  await Promise.all(
    CacheKeys.leaderboard.rankingPatterns.map((pattern) =>
      cacheDeletePattern(pattern),
    ),
  );
}

/**
 * Debounced leaderboard invalidation for high-frequency game settlements.
 *
 * Uses an atomic SET NX EX lock in Redis: the first settlement in a window
 * wins the lock and performs the purge; any later settlement within the
 * window NX-fails and skips (staleness is masked by the 5-min read TTL).
 * When Redis/KV is unavailable the lock acquisition no-ops (withRedis returns
 * null) and we purge immediately, preserving today's behavior exactly.
 */
export async function debouncedInvalidateLeaderboards(): Promise<void> {
  const won = await withRedis(async (redis) => {
    const res = await redis.set(CacheKeys.leaderboard.debounce, "1", {
      ex: LEADERBOARD_DEBOUNCE_SECONDS,
      nx: true,
    });
    return res === "OK";
  });

  // won === null (Redis unavailable) OR won === true (we hold the lock):
  // purge now. won === false (another settlement already purged within the
  // window): skip.
  if (won === false) return;
  // Purge only the ranking domains — per-game boards (grynd:lb:game:*) are
  // left to their read TTL (they only change when their own game is played,
  // so purging them here would recompute full-table aggregates on every
  // unrelated settlement burst). The weekly reset / admin flush still wipe
  // everything via invalidateAllLeaderboards.
  await purgeLeaderboardRankings();
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
 * Invalidate the cached per-game Elo rating boards.
 *
 * Rating boards are small (only players who have completed a rated match in
 * that game) and change only when a rated match settles, so they are purged
 * eagerly rather than debounced. Pass a game key to purge just that game's
 * pages; omit it to purge every rating board (used by the weekly reset and
 * admin cache flush).
 */
export async function invalidateRatingBoards(gameKey?: string): Promise<void> {
  await cacheDeletePattern(
    gameKey ? CacheKeys.rating.gameAll(gameKey) : CacheKeys.rating.all,
  );
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
    // Leaderboards are debounced: game settlements are too frequent to
    // wipe the whole ranking cache on every single one. Recent-games and
    // the caller's own stats stay eagerly keyed per-user (cheap, no
    // stampede). The weekly reset / admin flush still invalidate
    // leaderboards immediately via invalidateAllLeaderboards.
    debouncedInvalidateLeaderboards(),
    // Elo rating boards are tiny (rated players only, one game per board),
    // so they can be purged eagerly on every settlement — a just-finished
    // rated match should show its new ranking immediately.
    invalidateRatingBoards(),
    invalidateRecentGames(),
    clerkId ? invalidateUserStats(clerkId) : Promise.resolve(),
  ]);
}
