CREATE TABLE IF NOT EXISTS pool_lobbies (
  id UUID PRIMARY KEY,
  host_user_id TEXT NOT NULL,
  opponent_user_id TEXT,
  wager INT NOT NULL CHECK (wager > 0),
  game_mode TEXT NOT NULL CHECK (game_mode IN ('pvp','ai_beginner','ai_medium','ai_hard')),
  status TEXT NOT NULL CHECK (status IN ('waiting','active','cancelled','completed','expired')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pool_matches (
  id UUID PRIMARY KEY,
  lobby_id UUID REFERENCES pool_lobbies(id) ON DELETE SET NULL,
  player1_id TEXT NOT NULL,
  player2_id TEXT,
  winner_id TEXT,
  wager INT NOT NULL CHECK (wager >= 0),
  prize_paid INT DEFAULT 0,
  house_fee INT DEFAULT 0,
  game_state JSONB,
  current_turn_user_id TEXT,
  status TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pool_shots (
  id UUID PRIMARY KEY,
  match_id UUID NOT NULL REFERENCES pool_matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  angle FLOAT NOT NULL,
  power FLOAT NOT NULL,
  result JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pool_player_stats (
  user_id TEXT PRIMARY KEY,
  wins INT DEFAULT 0,
  losses INT DEFAULT 0,
  games_played INT DEFAULT 0,
  total_wagered BIGINT DEFAULT 0,
  total_won BIGINT DEFAULT 0,
  biggest_win INT DEFAULT 0,
  current_streak INT DEFAULT 0,
  best_streak INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pool_matches_player1 ON pool_matches(player1_id);
CREATE INDEX IF NOT EXISTS idx_pool_matches_player2 ON pool_matches(player2_id);
CREATE INDEX IF NOT EXISTS idx_pool_matches_created ON pool_matches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pool_shots_match ON pool_shots(match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pool_lobbies_status ON pool_lobbies(status, created_at DESC);
