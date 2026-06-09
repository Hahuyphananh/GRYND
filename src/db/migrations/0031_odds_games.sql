CREATE TABLE IF NOT EXISTS odds_games (
  id SERIAL PRIMARY KEY,
  player1_id VARCHAR(255) NOT NULL,
  player2_id VARCHAR(255),
  wager INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting',
  winner VARCHAR(10),
  result VARCHAR(15),
  payout INTEGER,
  is_ai BOOLEAN NOT NULL DEFAULT FALSE,
  game_state JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_odds_games_status ON odds_games(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_odds_games_player1 ON odds_games(player1_id);
