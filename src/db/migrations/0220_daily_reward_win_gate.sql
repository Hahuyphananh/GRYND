-- 0220_daily_reward_win_gate.sql
--
-- The daily login reward now requires a WIN, not merely a game start.
--
-- `users.last_played_game_date` is stamped when a session starts, so a player
-- could open a practice match against the AI and resign immediately to unlock
-- the reward. Wins are recorded by authoritative server settlement writers:
-- the rating writer (src/lib/rating.js) for rated modes, and the PvP path of
-- the leaderboard-counter writer (src/lib/leaderboardCounters.js) for modes
-- that settle outside Elo. A win there is a server-derived result, never a
-- client claim.
--
-- This column is the marker the reward reads: the UTC day the player last won an
-- online match. It is NULL until the player wins their first such match, which
-- reads correctly as "no win today" for every existing account.
--
-- Additive and idempotent: safe to re-run.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_won_game_date" date;

COMMENT ON COLUMN "users"."last_won_game_date" IS
  'UTC day of the player''s last online match win; gates the daily login reward';
