-- 0216: Historical OVERALL RANK snapshots (daily) — the ranking-progression
-- history the GRYND PRO dashboard charts.
--
-- WHY A NEW TABLE
-- ---------------
-- Elo and trophy HISTORY already exists and is authoritative: `rating_events`
-- and `trophy_events` are per-match journals written inside each settlement
-- transaction, so a player's rating curve and trophy curve can be rebuilt from
-- real recorded results (see src/lib/stats/performance.ts). RANK is the one
-- thing that cannot be rebuilt: a rank is a position among everyone else at a
-- point in time, and only the CURRENT position is stored (the
-- `rating_leaderboard_mv` materialized view, migration 0200, plus the live
-- Overall Elo board in src/lib/rating.js). Nothing anywhere holds "where was
-- this player ranked last Tuesday" — so this table records it from now on.
--
-- It is deliberately NOT back-filled: inventing history from today's rank is
-- exactly what the dashboard must never do. A player's rank curve therefore
-- starts the first day a snapshot is taken for them, and the UI says so.
--
-- WHAT "OVERALL RANK" MEANS HERE
-- ------------------------------
-- The platform's established cross-game ranking metric is **Overall Elo** (the
-- mean of a player's ESTABLISHED per-game ratings — `games_rated >= 10` each,
-- at least 3 such games; see overallEloFromRatings in src/lib/elo.js and
-- OVERALL_MIN_GAMES). Its board position is the "Overall Elo" rank, computed
-- exactly as `fetchOverallEloLeaderboard` orders it:
--
--   rank = 1 + COUNT(players with a strictly higher overall Elo, ties broken
--                          by the lower users.id)
--
-- A player with no overall rating (fewer than 3 established games) is NOT
-- ranked: `overall_elo`/`overall_rank` stay NULL and `eligible_games` records
-- how many established games they had, so the chart can say "not ranked yet"
-- instead of plotting a zero. Per-game boards are a different ranking system
-- and are deliberately NOT mixed in here.
--
-- BUCKETING / INDEXING
-- --------------------
-- One row per player per UTC day (`bucket`), enforced by the UNIQUE index —
-- that is the duplicate guard: a re-run of the daily sweep, and the dashboard's
-- own self-healing capture, both upsert on (user_id, bucket) and can never
-- produce a second row for the same player and day. The same index serves the
-- dashboard's "this player, this date range" read (user_id, bucket) and the
-- sweep's per-day pass uses the `bucket` index.
--
-- Persistent: an ordinary table (not a view/cache), so it survives deployments.
--
-- Idempotent: CREATE ... IF NOT EXISTS throughout, and no existing table, row or
-- index is touched.

CREATE TABLE IF NOT EXISTS "player_rank_snapshots" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- UTC day the snapshot describes.
  "bucket" date NOT NULL,
  -- Overall Elo at capture (NULL while the player is not yet ranked).
  "overall_elo" integer,
  -- Board position at capture (NULL while the player is not yet ranked).
  "overall_rank" integer,
  -- Established per-game ratings that fed the average (0 when unranked).
  "eligible_games" integer NOT NULL DEFAULT 0,
  "captured_at" timestamp NOT NULL DEFAULT now()
);

-- Duplicate guard + the player/timestamp read path.
CREATE UNIQUE INDEX IF NOT EXISTS "player_rank_snapshots_user_bucket_unique"
  ON "player_rank_snapshots" ("user_id", "bucket");

-- The daily sweep's pass over one bucket.
CREATE INDEX IF NOT EXISTS "player_rank_snapshots_bucket_idx"
  ON "player_rank_snapshots" ("bucket");
