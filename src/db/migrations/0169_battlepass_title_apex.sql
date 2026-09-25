-- 0169: Retire the High Roller-flavored Battle Pass title.
--
-- GRYND membership is a single plan (GRYND PRO) — the retired High Roller tier
-- no longer exists (see migration 0168). The level-75 Battle Pass title
-- "High Roller Legend" is therefore renamed to "Apex Legend", and the catalog
-- KEY changes too (bp_high_roller_legend -> bp_apex_legend) so no obsolete tier
-- name survives in the catalog or in the reward track.
--
-- Ownership is preserved: existing user_special_titles rows are re-pointed at
-- the new key before the old catalog row is removed. Idempotent — safe to run
-- repeatedly.

-- 1) New catalog row (idempotent).
INSERT INTO "special_titles" ("key", "name", "description", "rarity")
VALUES ('bp_apex_legend', 'Apex Legend', 'Battlepass-exclusive title', 'Elite')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

-- 2) Drop any ownership row that would duplicate the new key for the same
--    user (only possible if someone already owns both).
DELETE FROM "user_special_titles"
 WHERE "title_key" = 'bp_high_roller_legend'
   AND EXISTS (
     SELECT 1 FROM "user_special_titles" AS u2
      WHERE u2."user_id" = "user_special_titles"."user_id"
        AND u2."title_key" = 'bp_apex_legend'
   );
--> statement-breakpoint

-- 3) Re-point every remaining owner of the old title.
UPDATE "user_special_titles"
   SET "title_key" = 'bp_apex_legend'
 WHERE "title_key" = 'bp_high_roller_legend';
--> statement-breakpoint

-- 4) Remove the old catalog row.
DELETE FROM "special_titles" WHERE "key" = 'bp_high_roller_legend';
--> statement-breakpoint
