BEGIN;

CREATE TABLE IF NOT EXISTS hex_duel_games (
  id SERIAL PRIMARY KEY,
  player1_id varchar(255) NOT NULL,
  player2_id varchar(255),
  wager_amount numeric(10,2) NOT NULL,
  winner varchar(10) NOT NULL,
  result varchar(10) NOT NULL,
  payout numeric(10,2),
  is_ai_game boolean NOT NULL DEFAULT false,
  ai_difficulty varchar(10),
  player1_moves integer NOT NULL DEFAULT 0,
  player2_moves integer NOT NULL DEFAULT 0,
  player1_territory integer NOT NULL DEFAULT 1,
  player2_territory integer NOT NULL DEFAULT 1,
  duration_seconds integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'completed',
  is_fun_mode boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hex_duel_player1_idx ON hex_duel_games(player1_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hex_duel_created_idx ON hex_duel_games(created_at DESC);

COMMIT;
