CREATE TABLE IF NOT EXISTS neon_territory_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id TEXT NOT NULL,
  player2_id TEXT NOT NULL,
  wager_amount INT NOT NULL,
  token_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  winner_id TEXT,
  game_state JSONB NOT NULL,
  turn_number INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS neon_territory_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES neon_territory_matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  turn_number INT NOT NULL,
  action_type TEXT NOT NULL DEFAULT 'attack' CHECK (action_type IN ('attack', 'reinforce', 'fortify')),
  target_x INT NOT NULL,
  target_y INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS neon_territory_stats (
  user_id TEXT PRIMARY KEY,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  games_played INT NOT NULL DEFAULT 0,
  biggest_streak INT NOT NULL DEFAULT 0,
  total_wagered BIGINT NOT NULL DEFAULT 0,
  total_tokens_won BIGINT NOT NULL DEFAULT 0
);
