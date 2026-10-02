-- 0200: Materialized leaderboard ranks.
--
-- `fetchRatingLeaderboard` (src/lib/rating.js) recomputed two expensive things
-- on EVERY uncached request:
--
--   1. `ROW_NUMBER() OVER (ORDER BY rating DESC, losses ASC, user_id ASC)`
--      across every rated row of the game. `LIMIT`/`OFFSET` sit in an outer
--      CTE, so neither could prune the window — each page re-sorted the whole
--      set, and every offset re-paid for it.
--   2. A full-table `GROUP BY` over `player_ratings` building the cross-game
--      "Overall Elo" badge. That aggregate is identical for every game and
--      every page, yet it was recomputed per request.
--
-- Worst case is exactly when it hurts: `invalidateAllLeaderboards()` runs on
-- match settlement, so the first read after a busy match pays the full scan.
--
-- This view computes both once. The UNIQUE index is required for
-- `REFRESH MATERIALIZED VIEW CONCURRENTLY`, which rebuilds the view without
-- blocking reads (see src/lib/leaderboardView.ts).
--
-- Idempotent: safe to run repeatedly.

CREATE MATERIALIZED VIEW IF NOT EXISTS "rating_leaderboard_mv" AS
SELECT
  r.game_key,
  r.user_id,
  (ROW_NUMBER() OVER (
     PARTITION BY r.game_key
     ORDER BY r.rating DESC, r.losses ASC, r.user_id ASC
   ))::int AS rank,
  r.rating,
  r.peak_rating,
  r.games_rated,
  r.wins,
  r.losses,
  r.draws,
  r.last_delta,
  r.last_rated_at,
  o2.overall_elo,
  COALESCE(o2.overall_games, 0) AS overall_games
FROM player_ratings r
LEFT JOIN (
  -- Cross-game "Overall Elo" badge. The thresholds must stay in sync with
  -- PROVISIONAL_GAMES = 10 and OVERALL_MIN_GAMES = 3 in src/lib/elo.js.
  SELECT
    r2.user_id,
    ROUND(AVG(r2.rating))::int AS overall_elo,
    COUNT(*)::int AS overall_games
  FROM player_ratings r2
  WHERE r2.games_rated >= 10
  GROUP BY r2.user_id
  HAVING COUNT(*) >= 3
) o2 ON o2.user_id = r.user_id;

-- Unique key: required by REFRESH ... CONCURRENTLY, and it is the index the
-- paged read uses for (game_key, rank) range scans.
CREATE UNIQUE INDEX IF NOT EXISTS "rating_leaderboard_mv_rank_key"
  ON "rating_leaderboard_mv" ("game_key", "rank", "user_id");

-- The "me" lookup: the caller's own row for one game.
CREATE INDEX IF NOT EXISTS "rating_leaderboard_mv_user_idx"
  ON "rating_leaderboard_mv" ("game_key", "user_id");

-- Populate immediately so the view is never empty before the first cron tick.
-- A plain (blocking) REFRESH is correct here: it is allowed inside the
-- migration transaction, unlike CONCURRENTLY.
REFRESH MATERIALIZED VIEW "rating_leaderboard_mv";
