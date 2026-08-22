/**
 * Redis Cache Key Prefixes
 *
 * All keys follow the pattern:   grynd:<domain>:<identifier>
 * This keeps keys namespaced and easy to evict by pattern.
 */

const PREFIX = "grynd";

export const CacheKeys = {
  // ── Leaderboards ──────────────────────────────────────────────
  leaderboard: {
    /**
     * Pattern for all all-time leaderboard keys.
     * grynd:lb:all-time:{category}:{limit}:{offset}
     */
    allTime: (category: string, limit: number, offset: number) =>
      `${PREFIX}:lb:all-time:${category}:${limit}:${offset}`,

    /**
     * Pattern for all weekly leaderboard keys.
     * grynd:lb:weekly:{category}:{limit}:{offset}
     */
    weekly: (category: string, limit: number, offset: number) =>
      `${PREFIX}:lb:weekly:${category}:${limit}:${offset}`,

    /**
     * Pattern for wins leaderboard keys.
     * grynd:lb:wins:{limit}:{offset}
     */
    wins: (limit: number, offset: number) =>
      `${PREFIX}:lb:wins:${limit}:${offset}`,

    /**
     * Pattern for daily streak leaderboard keys.
     * grynd:lb:daily-streak:{type}:{limit}:{offset}
     */
    dailyStreak: (type: string, limit: number, offset: number) =>
      `${PREFIX}:lb:daily-streak:${type}:${limit}:${offset}`,

    /** Wildcard pattern for eviction */
    all: `${PREFIX}:lb:*`,
  },

  // ── User Stats ───────────────────────────────────────────────
  userStats: (clerkId: string) => `${PREFIX}:user:stats:${clerkId}`,
  userStatsAll: `${PREFIX}:user:stats:*`,

  // ── Recent Games ─────────────────────────────────────────────
  recentGames: (page: number, limit: number) =>
    `${PREFIX}:recent-games:${page}:${limit}`,
  recentGamesAll: `${PREFIX}:recent-games:*`,

  // ── Big Wins ─────────────────────────────────────────────────
  bigWins: () => `${PREFIX}:big-wins:latest`,
  bigWinsAll: `${PREFIX}:big-wins:*`,

  // ── Hex Duel AI Session Tokens ──────────────────────────────
  /**
   * Short-lived, single-use proof that a user recently started a Hex
   * Duel AI match via /api/hex-duel/start-game. The token is required
   * on the matching /api/hex-duel/end-game call so the server can
   * verify the `isAiGame` claim didn't come from a forged PvP request.
   *
   * grynd:hex-duel:ai-session:<sessionId>
   */
  hexDuelAiSession: (sessionId: string) =>
    `${PREFIX}:hex-duel:ai-session:${sessionId}`,
} as const;

/**
 * Cache TTL Configuration
 *
 * Primary strategy is event-driven invalidation.
 * TTLs act as safety nets so stale data never persists indefinitely.
 */
export const CacheTTL = {
  /** Leaderboard queries: 5 min backup TTL */
  leaderboard: 5 * 60,

  /** Individual user stats: 3 min backup TTL */
  userStats: 3 * 60,

  /** Recent games feed: 60s backup TTL */
  recentGames: 60,

  /** Big wins feed: 60s backup TTL */
  bigWins: 60,

  /**
   * Hex Duel AI session token. 15 min is plenty for a full AI match
   * (including reconnect windows) but short enough that a leaked
   * token can't be replayed for long if a user's DevTools network
   * tab is exposed.
   */
  hexDuelAiSession: 15 * 60,
} as const;
