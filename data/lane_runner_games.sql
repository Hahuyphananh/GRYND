-- Neon SQL: lane runner game history table
CREATE TABLE IF NOT EXISTS lane_runner_games (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bet_amount numeric(10,2) NOT NULL,
  payout numeric(10,2) NOT NULL DEFAULT 0.00,
  result varchar(20) NOT NULL DEFAULT 'pending',
  difficulty varchar(20) NOT NULL,
  current_lane integer NOT NULL DEFAULT 0,
  multiplier numeric(12,4) NOT NULL DEFAULT 1.0000,
  client_seed varchar(255) NOT NULL,
  server_seed_hash varchar(255) NOT NULL,
  server_seed varchar(255),
  nonce varchar(255) NOT NULL,
  outcome_sequence jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'completed',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lane_runner_games_user_idx ON lane_runner_games(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lane_runner_games_result_idx ON lane_runner_games(result);
