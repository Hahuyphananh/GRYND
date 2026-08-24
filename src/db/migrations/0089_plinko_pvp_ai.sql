-- Free Plinko Duel practice matches use the normal physics and launch flow,
-- but never escrow, pay out, or update PvP statistics.
ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean NOT NULL DEFAULT false;
nice 