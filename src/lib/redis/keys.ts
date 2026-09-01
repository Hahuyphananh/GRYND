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

    /**
     * Pattern for per-game leaderboard keys.
     * grynd:lb:game:{game}:{limit}:{offset}
     */
    game: (game: string, limit: number, offset: number) =>
      `${PREFIX}:lb:game:${game}:${limit}:${offset}`,

    /** Wildcard pattern for eviction */
    all: `${PREFIX}:lb:*`,

    /**
     * Debounce lock for eager leaderboard invalidation from game
     * settlements. Kept separately from the cached keys so the wipe can be
     * throttled to ~once per DEBOUNCE window regardless of settlement
     * volume (avoiding a cache stampede of full-table sorts).
     */
    debounce: `${PREFIX}:lb:debounce`,
  },

  // ── User Stats ───────────────────────────────────────────────
  userStats: (clerkId: string) => `${PREFIX}:user:stats:${clerkId}`,
  userStatsAll: `${PREFIX}:user:stats:*`,

  // ── Age-gate lookup (middleware) ───────────────────────────
  // Caches the `users.age` value resolved for the middleware age gate so a
  // protected page load doesn't hit Neon on every navigation. Age only
  // changes on a birthdate edit, so a short TTL is plenty.
  userAge: (clerkId: string) => `${PREFIX}:user:age:${clerkId}`,
  userAgeAll: `${PREFIX}:user:age:*`,

  // ── Friend presence ────────────────────────────────────────
  // Short-lived per-user cache for the friends game-presence feed so
  // multiple tabs/screens don't each run a friend_relations join on every
  // poll tick. Online status can tolerate a few seconds of staleness.
  friendPresence: (clerkId: string) => `${PREFIX}:friend-presence:${clerkId}`,
  friendPresenceAll: `${PREFIX}:friend-presence:*`,

  // ── Special titles map (chat / anywhere a title-by-key lookup is made) ─
  // The map of special-title key → name is tiny and only changes when an
  // admin edits titles, so it can be cached to avoid a full-table read on
  // every chat GET.
  specialTitles: () => `${PREFIX}:special-titles`,

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

  /** Age-gate value: 15 min — birthdate changes are rare and the
      update-birthdate flow could invalidate the cache directly. */
  userAge: 15 * 60,

  /** Friend presence: 10s — online status tolerates a few seconds of
      staleness and the client polls every 60s anyway. */
  friendPresence: 10,

  /** Recent games feed: 60s backup TTL */
  recentGames: 60,

  /** Big wins feed: 60s backup TTL */
  bigWins: 60,

  /** Special titles map: 5 min — titles rarely change. */
  specialTitles: 5 * 60,

  /**
   * Hex Duel AI session token. 15 min is plenty for a full AI match
   * (including reconnect windows) but short enough that a leaked
   * token can't be replayed for long if a user's DevTools network
   * tab is exposed.
   */
  hexDuelAiSession: 15 * 60,
} as const;
