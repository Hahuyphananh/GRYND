-- 0146: retention + inactivity indexes
--
-- Two audit findings:
--
-- 1. GET /api/jobs/retention purges terminal rows nightly with
--    `WHERE status IN (...) AND ended_at < cutoff`. Several PvP match
--    tables (and hex_duel_games) had NO status index at all, so every
--    nightly purge was a full-table scan + delete on the biggest game
--    tables. `(status, ended_at)` turns each purge into an index range
--    scan. (chess_games / rps_pvp_games got theirs in 0145; the
--    status+(created_at|ended_at) indexes below already cover the rest.)
--
-- 2. GET /api/jobs/inactivity-check filters user_automation_state on
--    (last_login_at <= cutoff AND last_inactivity_email_sent_at IS NULL)
--    with no index — a full scan every run. A (last_login_at,
--    last_inactivity_email_sent_at) index makes the candidate lookup an
--    index range scan.

CREATE INDEX IF NOT EXISTS "hex_duel_games_status_ended_idx"
  ON "hex_duel_games" ("status", "ended_at");
CREATE INDEX IF NOT EXISTS "mines_pvp_status_ended_idx"
  ON "mines_pvp_matches" ("status", "ended_at");
CREATE INDEX IF NOT EXISTS "memory_grid_status_ended_idx"
  ON "memory_grid_matches" ("status", "ended_at");
CREATE INDEX IF NOT EXISTS "roulette_pvp_status_ended_idx"
  ON "roulette_pvp_matches" ("status", "ended_at");
CREATE INDEX IF NOT EXISTS "blackjack_pvp_status_ended_idx"
  ON "blackjack_pvp_matches" ("status", "ended_at");
CREATE INDEX IF NOT EXISTS "lane_rush_duel_status_ended_idx"
  ON "lane_rush_duel_matches" ("status", "ended_at");
CREATE INDEX IF NOT EXISTS "dots_and_boxes_status_ended_idx"
  ON "dots_and_boxes_games" ("status", "ended_at");

CREATE INDEX IF NOT EXISTS "user_automation_inactivity_idx"
  ON "user_automation_state" ("last_login_at", "last_inactivity_email_sent_at");