-- Add mines_count column to mines_games for tracking how many mines were on the board
ALTER TABLE mines_games ADD COLUMN IF NOT EXISTS mines_count INTEGER DEFAULT 0;
