-- 0167: Retire the token-flavored Battle Pass title.
--
-- The Battle Pass no longer pays tokens — the reward track is XP + cosmetics
-- only (see src/lib/battlepassRewards.js). The level-10 title "Token Shuffler"
-- is therefore renamed to "Pass Climber". The catalog KEY changes too
-- (bp_token_shuffler -> bp_pass_climber) so no token reference survives in the
-- catalog or in the reward track.
--
-- Ownership is preserved: existing user_special_titles rows are re-pointed at
-- the new key before the old catalog row is removed. Idempotent — safe to run
-- repeatedly.

-- 1) New catalog row (idempotent).
INSERT INTO "special_titles" ("key", "name", "description", "rarity")
VALUES ('bp_pass_climber', 'Pass Climber', 'Battlepass-exclusive title', 'Common')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint

-- 2) Drop any ownership row that would duplicate the new key for the same
--    user (only possible if someone already owns both).
DELETE FROM "user_special_titles"
 WHERE "title_key" = 'bp_token_shuffler'
   AND EXISTS (
     SELECT 1 FROM "user_special_titles" AS u2
      WHERE u2."user_id" = "user_special_titles"."user_id"
        AND u2."title_key" = 'bp_pass_climber'
   );
--> statement-breakpoint

-- 3) Re-point every remaining owner of the old title.
UPDATE "user_special_titles"
   SET "title_key" = 'bp_pass_climber'
 WHERE "title_key" = 'bp_token_shuffler';
--> statement-breakpoint

-- 4) Remove the old catalog row.
DELETE FROM "special_titles" WHERE "key" = 'bp_token_shuffler';
--> statement-breakpoint
