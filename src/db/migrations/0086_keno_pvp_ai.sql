-- Keno PvP free human-vs-AI matches.
-- The bot occupies player2_id but is not a real user and must never
-- participate in token or PvP-stat accounting.
ALTER TABLE "keno_pvp_matches"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean NOT NULL DEFAULT false;
