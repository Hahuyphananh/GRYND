CREATE TABLE IF NOT EXISTS farkle_rooms (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  wager INTEGER NOT NULL,
  pot INTEGER NOT NULL,
  game_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS farkle_players (
  id SERIAL PRIMARY KEY,
  room_id TEXT REFERENCES farkle_rooms(id),
  user_id TEXT NOT NULL,
  is_ai BOOLEAN DEFAULT FALSE,
  score INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS farkle_actions (
  id SERIAL PRIMARY KEY,
  room_id TEXT,
  user_id TEXT,
  action_type TEXT,
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_farkle_rooms_status ON farkle_rooms(status);
CREATE INDEX IF NOT EXISTS idx_farkle_players_room_id ON farkle_players(room_id);
CREATE INDEX IF NOT EXISTS idx_farkle_actions_room_id ON farkle_actions(room_id, created_at);
