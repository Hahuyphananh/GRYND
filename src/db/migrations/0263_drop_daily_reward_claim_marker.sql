-- 0263_drop_daily_reward_claim_marker.sql
--
-- The daily token reward is retired. `users.last_daily_reward_claimed` was its
-- day-keyed idempotency marker and has no other reader or writer, so the column
-- is dropped here.
--
-- NOT dropped, deliberately:
--   * `token_transactions` rows with reference_type = 'daily-reward' — existing
--     token history is preserved.
--   * user balances and every streak column.
--   * `users.last_won_game_date` / `users.last_played_game_date` — retained as
--     historical activity data; they no longer gate any feature.
--
-- Forward-only and idempotent: safe to re-run.

ALTER TABLE "users"
  DROP COLUMN IF EXISTS "last_daily_reward_claimed";

COMMENT ON COLUMN "users"."last_won_game_date" IS
  'Historical: last recorded win day, retained for existing data; no feature gates on it.';
