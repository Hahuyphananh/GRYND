CREATE TABLE IF NOT EXISTS yahtzee_rooms (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  wager INTEGER NOT NULL,
  pot INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS yahtzee_players (
  id SERIAL PRIMARY KEY,
  room_id TEXT REFERENCES yahtzee_rooms(id),
  user_id TEXT NOT NULL,
  is_ai BOOLEAN DEFAULT FALSE,
  score INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS yahtzee_actions (
  id SERIAL PRIMARY KEY,
  room_id TEXT,
  user_id TEXT,
  action_type TEXT,
  payload JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yahtzee_rooms_status ON yahtzee_rooms(status);
CREATE INDEX IF NOT EXISTS idx_yahtzee_players_room_id ON yahtzee_players(room_id);
CREATE INDEX IF NOT EXISTS idx_yahtzee_actions_room_id ON yahtzee_actions(room_id, created_at);
