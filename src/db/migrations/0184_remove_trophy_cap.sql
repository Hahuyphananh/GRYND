-- 0184: Remove the per-game trophy cap — trophies are now UNBOUNDED.
--
-- Migration 0177 capped a game's trophies at 1,000 (TROPHY_MAX). That cap is
-- gone: trophies keep climbing for as long as a player wins, and there is no
-- overall maximum either. Only the floor stays (a count can never go negative).
--
-- The columns are still INTEGER, which is far beyond any reachable count.
-- Idempotent: safe to run repeatedly.

ALTER TABLE "player_trophies" DROP CONSTRAINT IF EXISTS "player_trophies_band";
--> statement-breakpoint
ALTER TABLE "player_trophies" ADD CONSTRAINT "player_trophies_floor"
  CHECK ("trophies" >= 0 AND "peak_trophies" >= 0);
--> statement-breakpoint

ALTER TABLE "trophy_identities" DROP CONSTRAINT IF EXISTS "trophy_identities_counts_nonneg";
--> statement-breakpoint
ALTER TABLE "trophy_identities" ADD CONSTRAINT "trophy_identities_counts_nonneg"
  CHECK ("trophies" >= 0 AND "peak_trophies" >= 0
         AND "games_rated" >= 0 AND "wins" >= 0 AND "losses" >= 0 AND "draws" >= 0);
