-- Migration: 0035_precision_matches_rounds
--
-- Adds the Precision PvP casino game tables. The schema mirrors the
-- conventions used by dice_matches / pool_matches / hex_duel_games:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * wager stored as numeric(10, 2) for currency arithmetic safety
--   * `status` kept as varchar(20) (not pgEnum) so future statuses can
--     be added without a destructive enum migration
--   * cascade delete from precision_matches → precision_rounds

-- ── precision_matches ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS precision_matches (
  id serial PRIMARY KEY,
  player1_id varchar(255) NOT NULL,
  player2_id varchar(255),
  wager numeric(10, 2) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'waiting',
  winner_id varchar(255),
  current_round integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_precision_matches_status
  ON precision_matches (status, created_at);
CREATE INDEX IF NOT EXISTS idx_precision_matches_player1
  ON precision_matches (player1_id, created_at);
CREATE INDEX IF NOT EXISTS idx_precision_matches_player2
  ON precision_matches (player2_id, created_at);

-- ── precision_rounds ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS precision_rounds (
  id serial PRIMARY KEY,
  match_id integer NOT NULL REFERENCES precision_matches(id) ON DELETE CASCADE,
  round_number integer NOT NULL,
  target_milliseconds integer NOT NULL,
  start_timestamp timestamp NOT NULL,
  player1_stop_timestamp timestamp,
  player2_stop_timestamp timestamp,
  player1_difference integer,
  player2_difference integer,
  winner_id varchar(255)
);

CREATE INDEX IF NOT EXISTS idx_precision_rounds_match_round
  ON precision_rounds (match_id, round_number);
