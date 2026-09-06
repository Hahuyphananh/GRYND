-- 0144: Daily responsible-play counters (UTC day).
--
-- The daily-loss guard (DailyLossGuard / navbar chip) used to compute
-- "down X tokens today" by fanning ouokt across every game history table
-- (GET /api/get-bet-history?since=… — ~24 queries per request, fired
-- twice per lobby page view). This migration adds two maintained
-- counters on `users` so the guard becomes a single indexed row read:
--
--   * daily_wagered — total staked today (real-money settlements only)
--   * daily_won     — total paid out today
--
-- daily_net = daily_won − daily_wagered, which matches the bet-history
-- tokenDiff sum (wins add payout − stake, losses subtract stake, draws
-- are net 0).
--
-- Bumped on every settlement by:
--   * src/lib/leaderboardCounters.js (the casino / funnel games)
--   * the recordPvPResult helpers in mines-pvp / keno-pvp / memory-grid /
--     lane-rush-duel server stores (the PvP games that settle outside the
--     counters funnel but still feed bet-history)
-- Crash Poker is settled with real table balances but also feeds
-- bet-history, so GET /api/user/daily-loss keeps a single indexed
-- crash-arena query for parity (this migration adds the
-- crash_arena_entries(user_id) index that query needs).
--
-- Reset to 0 at midnight UTC by GET /api/jobs/daily-reset (see
-- vercel.json). Idempotent, additive — safe to re-run.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "daily_wagered" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "daily_won" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crash_arena_entries_user_idx" ON "crash_arena_entries" ("user_id");