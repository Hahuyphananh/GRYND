-- Add is_ai flag to mines_pvp_matches for free human-vs-AI matches.
ALTER TABLE mines_pvp_matches ADD COLUMN IF NOT EXISTS is_ai boolean NOT NULL DEFAULT false;
