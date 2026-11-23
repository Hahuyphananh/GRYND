-- 0267: index the per-game competitive best-streak leaderboard.
--
-- The classement reads one game at a time:
--   WHERE game_key = $1 AND best_streak > 0
--   ORDER BY best_streak DESC, user_id ASC
--
-- The primary key (user_id, game_key) cannot serve that filter/order, so this
-- index covers both the equality predicate and the deterministic ranking.
-- Additive and idempotent; no existing row is changed.

CREATE INDEX IF NOT EXISTS "user_competitive_streaks_game_best_idx"
  ON "user_competitive_streaks" ("game_key", "best_streak" DESC, "user_id");
