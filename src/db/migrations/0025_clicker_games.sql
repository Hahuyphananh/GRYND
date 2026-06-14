-- Migration: Add clicker_games table to persist GoonBet Clicker round history
-- Used by get-bet-history and user-stats to show clicker games in bet history

CREATE TABLE IF NOT EXISTS clicker_games (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  bet_amount INTEGER NOT NULL,
  payout INTEGER NOT NULL,
  multiplier NUMERIC(10, 4) NOT NULL,
  busted BOOLEAN NOT NULL DEFAULT false,
  clicks INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clicker_games_user_id
  ON clicker_games (user_id, created_at);
