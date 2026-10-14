-- 0214_daily_rewards.sql
--
-- Brings the daily login reward back as a token payout, and adds the one column
-- the reward needs that does not already exist.
--
--   1. `users.last_played_game_date` — the UTC day the player last started a
--      real game session, written by POST /api/game-plays (which already fires
--      once per game start for BOTH 1v1 PvP and vs-AI sessions). The daily
--      login reward is gated on this being today, so a player must play a game
--      before they can claim — see src/lib/tokens/dailyReward.ts.
--
--   2. `users.last_daily_reward_claimed` — NOT added here. The column already
--      exists from the earlier daily-reward system (see migration
--      0092_missing_tables_from_push.sql) and was left in place when that
--      system was retired, so it is reused as-is as the day-keyed claim marker.
--      The reward is idempotent on this column AND on a ledger row keyed
--      `("daily-reward", "<utc-day>:<clerkId>")` in `token_transactions`.
--
-- Additive and idempotent: safe to re-run. `last_played_game_date` stays NULL
-- for every existing row until that player next starts a game, which reads
-- correctly as "has not played today".

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_played_game_date" date;
