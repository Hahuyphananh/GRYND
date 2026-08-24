-- Roulette PvP free AI matches.
-- The bot occupies player 2 and uses the same server state machine, while
-- stake and payout accounting remain disabled for these matches.
ALTER TABLE "roulette_pvp_matches"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean NOT NULL DEFAULT false;
