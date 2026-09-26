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
     * Pattern for daily streak leaderboard keys.
     * grynd:lb:daily-streak:{type}:{limit}:{offset}
     */
    dailyStreak: (type: string, limit: number, offset: number) =>
      `${PREFIX}:lb:daily-streak:${type}:${limit}:${offset}`,

    /**
     * Patterns for the ranking boards every settlement can affect
     * (all-time, weekly, daily-streak). The per-game boards are NOT here:
     * they are the Elo boards under `rating` below, and they are purged
     * eagerly by that game's own settlement instead of by a debounced
     * full-table purge. `all` (below) still wipes everything for the
     * weekly reset / admin flush.
     */
    rankingPatterns: [
      `${PREFIX}:lb:all-time:*`,
      `${PREFIX}:lb:weekly:*`,
      `${PREFIX}:lb:daily-streak:*`,
    ],

    /** Wildcard pattern for eviction of ALL leaderboard keys */
    all: `${PREFIX}:lb:*`,

    /**
     * Debounce lock for eager leaderboard invalidation from game
     * settlements. Kept separately from the cached keys so the wipe can be
     * throttled to ~once per DEBOUNCE window regardless of settlement
     * volume (avoiding a cache stampede of full-table sorts).
     */
    debounce: `${PREFIX}:lb:debounce`,
  },

  // ── Per-game Elo rating boards ─────────────────────────────────
  // Kept in their own namespace (not under `lb:`) so the debounced
  // settlement purge and the leaderboard patterns never touch them; a rating
  // board's own read TTL is short (see CacheTTL.rating) and a rated match
  // purges just its own game's pages.
  rating: {
    /** grynd:rating:{game}:{limit}:{offset} */
    board: (game: string, limit: number, offset: number) =>
      `${PREFIX}:rating:${game}:${limit}:${offset}`,

    /** Every page of a single game's rating board. */
    gameAll: (game: string) => `${PREFIX}:rating:${game}:*`,

    /**
     * grynd:rating:overall:{limit}:{offset}
     *
     * The cross-game aggregate board. It depends on EVERY game's ratings, so
     * any settlement (or the weekly/admin flush) purges it alongside the
     * per-game pages via `all`.
     */
    overall: (limit: number, offset: number) =>
      `${PREFIX}:rating:overall:${limit}:${offset}`,

    /** Wildcard pattern for eviction of ALL rating boards. */
    all: `${PREFIX}:rating:*`,
  },

  // ── Per-game trophy boards ─────────────────────────────────────
  // Mirrors the `rating` namespace (and is deliberately under `trophy:`, not
  // `lb:`), so the debounced settlement purge never touches these and a
  // performed match purges just its own game's pages. Overall Trophies
  // depends on EVERY game, so any settlement purges it via `all`.
  trophy: {
    /** grynd:trophy:{game}:{limit}:{offset} */
    board: (game: string, limit: number, offset: number) =>
      `${PREFIX}:trophy:${game}:${limit}:${offset}`,

    /** Every page of a single game's trophy board. */
    gameAll: (game: string) => `${PREFIX}:trophy:${game}:*`,

    /** grynd:trophy:overall:{limit}:{offset} */
    overall: (limit: number, offset: number) =>
      `${PREFIX}:trophy:overall:${limit}:${offset}`,

    /** Every page of the cross-game Overall Trophies board. */
    overallAll: `${PREFIX}:trophy:overall:*`,

    /** Wildcard pattern for eviction of ALL trophy boards. */
    all: `${PREFIX}:trophy:*`,
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

  // ── User-MFA flag lookup (middleware) ────────────────────────
  // Caches `users.mfa_enabled` for the middleware user-MFA gate so a page
  // load doesn't hit the DB on every navigation. The flag only changes on
  // an explicit enable/disable in Settings, and the security routes
  // invalidate the key directly (cacheDelete) so the TTL is just a
  // safety net.
  userMfa: (clerkId: string) => `${PREFIX}:user:mfa:${clerkId}`,
  userMfaAll: `${PREFIX}:user:mfa:*`,

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

  // ── Bet history ──────────────────────────────────────────────
  // Per-user bet history (the profile's recent-bets list). Append-only per
  // user, so a short TTL turns the ~23-query fan-out into one Redis GET.
  betHistory: (clerkId: string) => `${PREFIX}:bet-history:${clerkId}`,

  // ── Live stats ───────────────────────────────────────────────
  // Games-played-today aggregate for the home ticker: a slow-moving daily
  // sum across ~20 game tables that the ticker polls every 30s. Cached so
  // each poll is a Redis GET instead of 20 Postgres COUNTs.
  liveStatsGamesToday: () => `${PREFIX}:live-stats:games-today`,

  // ── Active players per game ──────────────────────────────────
  // The casino lobby's "N playing" badge. One tiny GROUP BY over
  // user_game_presence (bounded by users × games, index-backed by
  // (game_key, last_seen_at)); cached so every lobby tab on the site shares
  // one Postgres read instead of issuing its own.
  activePlayers: () => `${PREFIX}:presence:active-players`,

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

  /** Elo rating boards: 60s. A rating board is small (only rated players),
      moves only when its own game is played, and is patched eagerly by the
      settlement that caused the change — so a short safety TTL is plenty. */
  rating: 60,

  /** Trophy boards: 60s, for the same reasons as `rating` — small per-game
      boards that are purged eagerly by their own game's settlement. */
  trophy: 60,

  /** Individual user stats: 3 min backup TTL */
  userStats: 3 * 60,

  /** Age-gate value: 15 min — birthdate changes are rare and the
      update-birthdate flow could invalidate the cache directly. */
  userAge: 15 * 60,

  /** User-MFA flag: 5 min safety net — the security routes invalidate it
      directly on enable/disable. */
  userMfa: 5 * 60,

  /** Friend presence: 10s — online status tolerates a few seconds of
      staleness and the client polls every 60s anyway. */
  friendPresence: 10,

  /** Active players per game: 10s — the badge is approximate by nature (the
      activity window is 3 min), so a few seconds of cache is invisible, and
      a lobby refresh can never turn into a per-tab Postgres query. */
  activePlayers: 10,

  /** Recent games feed: 60s backup TTL */
  recentGames: 60,

  /** Special titles map: 5 min — titles rarely change. */
  specialTitles: 5 * 60,

  /** Live-stats games-played-today aggregate: 5 min — it's a daily sum
      that barely moves at the ticker's 30s poll cadence. */
  liveStatsGamesToday: 5 * 60,

  /** Bet history: 60s — a just-settled bet appears within a minute and the
      profile's recent-bets list tolerates that easily. */
  betHistory: 60,

  /**
   * Hex Duel AI session token. 15 min is plenty for a full AI match
   * (including reconnect windows) but short enough that a leaked
   * token can't be replayed for long if a user's DevTools network
   * tab is exposed.
   */
  hexDuelAiSession: 15 * 60,
} as const;
