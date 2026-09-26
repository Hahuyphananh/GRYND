-- 0177: Lower the trophy cap to 1,000/game and re-gate Elo as Prestige.
--
-- Two changes ship together:
--
-- 1) TROPHY CAP — the per-game cap drops from 10,000 to 1,000 (TROPHY_MAX in
--    src/lib/trophies.js). There are 20 rated games (RATED_GAMES in
--    src/lib/rating.js), so the additive overall maximum is 20,000
--    (OVERALL_TROPHY_MAX) and the Battle Pass spans that across its 100 levels
--    (200 trophies/level). Existing counts are clamped down to the new cap and
--    both band CHECK constraints are rebuilt at 1,000. Trophies are NOT reset —
--    a player keeps their (clamped) progress.
--
-- 2) PRESTIGE RE-GATE — Elo is now tracked SILENTLY from a player's first rated
--    match and revealed only once that game's trophies reach the cap, where it
--    becomes that game's PRESTIGE (src/lib/prestige.js). To give everyone the
--    same clean, gated start, all previously-visible Elo is reset to the 1000
--    baseline: player_ratings and rating_identities go back to 1000 / 0, and
--    the rating journal (rating_events) is cleared because the ratings it
--    described no longer exist.
--
-- Idempotent: safe to run repeatedly.

-- 1a) Clamp stored counts down to the new cap BEFORE tightening the constraint.
UPDATE "player_trophies"
   SET "trophies" = LEAST("trophies", 1000),
       "peak_trophies" = LEAST("peak_trophies", 1000),
       "updated_at" = NOW()
 WHERE "trophies" > 1000 OR "peak_trophies" > 1000;
--> statement-breakpoint

UPDATE "trophy_identities"
   SET "trophies" = LEAST("trophies", 1000),
       "peak_trophies" = LEAST("peak_trophies", 1000),
       "updated_at" = NOW()
 WHERE "trophies" > 1000 OR "peak_trophies" > 1000;
--> statement-breakpoint

-- 1b) Rebuild the band constraints at the new 1,000 cap.
ALTER TABLE "player_trophies" DROP CONSTRAINT IF EXISTS "player_trophies_band";
--> statement-breakpoint
ALTER TABLE "player_trophies" ADD CONSTRAINT "player_trophies_band"
  CHECK ("trophies" >= 0 AND "trophies" <= 1000
         AND "peak_trophies" >= 0 AND "peak_trophies" <= 1000);
--> statement-breakpoint

ALTER TABLE "trophy_identities" DROP CONSTRAINT IF EXISTS "trophy_identities_counts_nonneg";
--> statement-breakpoint
ALTER TABLE "trophy_identities" ADD CONSTRAINT "trophy_identities_counts_nonneg"
  CHECK ("trophies" >= 0 AND "trophies" <= 1000
         AND "peak_trophies" >= 0 AND "peak_trophies" <= 1000
         AND "games_rated" >= 0 AND "wins" >= 0 AND "losses" >= 0 AND "draws" >= 0);
--> statement-breakpoint

-- 2) Reset all Elo to the 1000 baseline so Prestige starts clean and gated.
UPDATE "player_ratings"
   SET "rating" = 1000,
       "peak_rating" = 1000,
       "games_rated" = 0,
       "wins" = 0,
       "losses" = 0,
       "draws" = 0,
       "last_delta" = 0,
       "last_rated_at" = NULL,
       "updated_at" = NOW()
 WHERE "rating" <> 1000
    OR "peak_rating" <> 1000
    OR "games_rated" <> 0
    OR "wins" <> 0
    OR "losses" <> 0
    OR "draws" <> 0
    OR "last_delta" <> 0;
--> statement-breakpoint

UPDATE "rating_identities"
   SET "rating" = 1000,
       "peak_rating" = 1000,
       "games_rated" = 0,
       "wins" = 0,
       "losses" = 0,
       "draws" = 0,
       "last_delta" = 0,
       "last_rated_at" = NULL,
       "updated_at" = NOW()
 WHERE "rating" <> 1000
    OR "peak_rating" <> 1000
    OR "games_rated" <> 0
    OR "wins" <> 0
    OR "losses" <> 0
    OR "draws" <> 0
    OR "last_delta" <> 0;
--> statement-breakpoint

-- The journal described the pre-reset ratings; clear it so Overall-Elo movement
-- and duplicate detection start from the new baseline.
DELETE FROM "rating_events";
