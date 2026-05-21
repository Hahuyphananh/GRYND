ALTER TABLE yahtzee_rooms
  ADD COLUMN IF NOT EXISTS game_state JSONB NOT NULL DEFAULT '{}'::jsonb;
