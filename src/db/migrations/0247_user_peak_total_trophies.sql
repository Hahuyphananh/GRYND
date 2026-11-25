-- 0247_user_peak_total_trophies.sql
--
-- Permanent player progression: a server-authoritative high-water mark for a
-- player's TOTAL trophies.
--
-- WHY
--   The player level is derived from total trophies (100 trophies per level,
--   level 100 at the top of the ladder). `player_trophies.trophies` can fall
--   after a ranked loss, so deriving the level from the current sum would take
--   an earned badge away. `users.peak_total_trophies` records the highest total
--   the player has ever reached; the level reads
--   max(current total, peak), so it is permanent.
--
--   Summing each game's own `peak_trophies` would be WRONG: those peaks happen
--   at different times and can add up to a total the player never held at once.
--   This column is the peak of the SUM.
--
-- SAFETY
--   * ADDITIVE ONLY: one nullable-free integer column with a 0 default. No
--     existing column, row, reward or trophy count is modified or deleted.
--   * BACKFILL: existing players start at their CURRENT total, the highest
--     total the database can still prove. Nobody loses a badge they can prove
--     today; from that floor the mark only ever rises. (A historical peak that
--     happened before this migration is not reconstructable from current rows.)
--   * The mark is maintained by a TRIGGER on `player_trophies`, so every
--     settlement path keeps it current without changing the trophy maths, the
--     settlement transaction, or any game's write flow.
--   * SERVER-AUTHORITATIVE: no API accepts a level, rank or peak value. The
--     trigger only ever raises the value, and nothing client-facing can write
--     `users.peak_total_trophies`.
--
-- Idempotent: safe to run repeatedly.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "peak_total_trophies" integer NOT NULL DEFAULT 0;

-- Backfill from the totals that exist today. GREATEST keeps a re-run harmless.
UPDATE "users" u
   SET "peak_total_trophies" = GREATEST(
         COALESCE(u."peak_total_trophies", 0),
         COALESCE(
           (SELECT SUM(t."trophies")::int
              FROM "player_trophies" t
             WHERE t."user_id" = u."id"),
           0
         )
       );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION sync_user_peak_total_trophies()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "users" u
     SET "peak_total_trophies" = GREATEST(
           COALESCE(u."peak_total_trophies", 0),
           COALESCE(
             (SELECT SUM(t."trophies")::int
                FROM "player_trophies" t
               WHERE t."user_id" = NEW."user_id"),
             0
           )
         )
   WHERE u."id" = NEW."user_id";
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "player_trophies_sync_peak_total" ON "player_trophies";
--> statement-breakpoint
CREATE TRIGGER "player_trophies_sync_peak_total"
  AFTER INSERT OR UPDATE OF "trophies" ON "player_trophies"
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_peak_total_trophies();
