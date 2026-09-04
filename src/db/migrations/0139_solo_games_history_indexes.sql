-- 0139: Per-user history indexes for the legacy solo game tables.
--
-- Every page load of profile bet history (GET /api/get-bet-history) fans out
-- per-table queries shaped like:
--
--   SELECT ... FROM <table> WHERE user_id = ? [AND created_at >= ?] LIMIT 200
--
-- None of these tables had a (user_id, created_at) index (verified across all
-- migrations; only lane_runner_games had one, from 0014), so each query was a
-- sequential scan. Same for the daily-loss guard's ?since= filter. These
-- indexes turn those scans into index range lookups.
--
-- Matches migration 0014's lane_runner_games_user_idx shape (user_id,
-- created_at DESC) and the index declarations added to src/db/schema.ts.
--
-- Additive and idempotent (safe to run repeatedly). Plain CREATE INDEX keeps
-- this runnable inside the Drizzle migrator transaction; if any of these
-- tables is very large at apply time, create the index out-of-band with
-- CREATE INDEX CONCURRENTLY instead (Neon/Postgres) before running this.

CREATE INDEX IF NOT EXISTS roulette_games_user_idx ON roulette_games (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS crash_games_user_idx ON crash_games (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS blackjack_games_user_idx ON blackjack_games (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mines_games_user_idx ON mines_games (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plinko_games_user_idx ON plinko_games (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS uno_games_user_idx ON uno_games (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rps_games_user_idx ON rps_games (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS keno_games_user_idx ON keno_games (user_id, created_at DESC);
