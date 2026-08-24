-- 0083_blackjack_pvp_ai.sql
-- Blackjack PvP: mark free human-vs-AI matches explicitly.
-- The bot occupies player 2 but is never a real user and must not
-- participate in token or PvP-stat accounting.
ALTER TABLE "blackjack_pvp_matches"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean NOT NULL DEFAULT false;
