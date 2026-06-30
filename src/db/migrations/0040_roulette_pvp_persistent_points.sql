-- ── Roulette PvP: persistent match "points" balance ────────────────────
-- Adds columns to roulette_pvp_matches so each player carries a
-- match-currency balance across rounds (instead of the round budget
-- resetting between rounds). The columns default to 100.00 so
-- existing rows from migration 0039 are backfilled to the spec's
-- starting value of 100 / `starting_points`.
ALTER TABLE "roulette_pvp_matches"
  ADD COLUMN IF NOT EXISTS "starting_points" numeric(10, 2) NOT NULL DEFAULT 100.00,
  ADD COLUMN IF NOT EXISTS "player_one_points" numeric(10, 2) NOT NULL DEFAULT 100.00,
  ADD COLUMN IF NOT EXISTS "player_two_points" numeric(10, 2) NOT NULL DEFAULT 100.00,
  ADD COLUMN IF NOT EXISTS "round_timer_seconds" integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS "sudden_death" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Backfill safety: any pre-migration rows in non-finished states
-- default to 100/100 which matches the spec; pre-migration finished
-- rows remain at the default and don't need their balances adjustednow 
-- (they're historical records, not live state).
