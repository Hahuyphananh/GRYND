-- 0188: De-brand the seeded catalogue content (Battle Pass / Prestige wording).
--
-- The systems themselves are gone (0185) and every item is granted to every
-- player (0186), but the seed rows still carried the old wording in
-- user-visible columns: special-title descriptions, four title names, the
-- "Battle Pass Vet" cosmetic badge, the two former "prestige" effects and one
-- membership perk line.
--
-- Deliberately does NOT touch migration files 0133/0136/0137/0148/0156/0167/
-- 0169 — applied migrations are immutable history. This migration is the
-- forward-only correction.
--
-- Idempotent: every statement matches on the old value, so a re-run is a no-op
-- (the renamed keys no longer exist under their old names).

-- ── 1) Special titles ──────────────────────────────────────────────────────
-- Fifteen rows carried the literal description "Battlepass-exclusive title".
UPDATE "special_titles"
   SET "description" = 'Exclusive title'
 WHERE "description" = 'Battlepass-exclusive title';
--> statement-breakpoint

UPDATE "special_titles"
   SET "description" = 'The ultimate Grynd title'
 WHERE "key" = 'bp_grynd_pass_legend';
--> statement-breakpoint

-- Names that still named the pass.
UPDATE "special_titles" SET "name" = 'First Steps'  WHERE "key" = 'bp_pass_starter';
--> statement-breakpoint
UPDATE "special_titles" SET "name" = 'Raider'       WHERE "key" = 'bp_pass_raider';
--> statement-breakpoint
UPDATE "special_titles" SET "name" = 'Climber'      WHERE "key" = 'bp_pass_climber';
--> statement-breakpoint
UPDATE "special_titles" SET "name" = 'Titan'        WHERE "key" = 'bp_battlepass_titan';
--> statement-breakpoint
UPDATE "special_titles" SET "name" = 'GRYND LEGEND' WHERE "key" = 'bp_grynd_pass_legend';
--> statement-breakpoint

-- ── 2) Cosmetic badge ──────────────────────────────────────────────────────
UPDATE "cosmetics"
   SET "name" = 'Veteran',
       "description" = 'A veteran of the Grynd arena.'
 WHERE "key" = 'badge-veteran';
--> statement-breakpoint

-- ── 3) The two former "prestige" effects ───────────────────────────────────
-- Ownership rows first (no FK to `cosmetics`, but the rename must land in one
-- direction), then the catalogue row itself: key, copy, category and cssClass.
UPDATE "user_cosmetics" SET "cosmetic_key" = 'elite-aura'  WHERE "cosmetic_key" = 'prestige-aura';
--> statement-breakpoint
UPDATE "user_cosmetics" SET "cosmetic_key" = 'elite-crown' WHERE "cosmetic_key" = 'prestige-crown';
--> statement-breakpoint

UPDATE "cosmetics"
   SET "key" = 'elite-aura',
       "name" = 'Elite Aura',
       "description" = 'A distinguished aura for a veteran profile.',
       "category" = 'elite_effect',
       "unlock_condition" = NULL,
       "visual" = '{"cssClass":"elite-aura","color":"#8b5cf6"}'::jsonb
 WHERE "key" = 'prestige-aura';
--> statement-breakpoint

UPDATE "cosmetics"
   SET "key" = 'elite-crown',
       "name" = 'Elite Crown',
       "description" = 'A crown floating above a veteran profile.',
       "category" = 'elite_effect',
       "unlock_condition" = NULL,
       "visual" = '{"cssClass":"elite-crown","color":"#f59e0b"}'::jsonb
 WHERE "key" = 'prestige-crown';
--> statement-breakpoint

-- Whoever had one equipped keeps it equipped under the new category key.
UPDATE "users"
   SET "equipped_cosmetics" = ("equipped_cosmetics" - 'prestige_effect')
                              || jsonb_build_object('elite_effect', "equipped_cosmetics" -> 'prestige_effect')
 WHERE "equipped_cosmetics" ? 'prestige_effect';
--> statement-breakpoint

-- ── 4) Membership perk line ────────────────────────────────────────────────
-- There is no Prestige progression to boost any more, so the line is dropped
-- rather than renamed.
UPDATE "token_subscription_plans"
   SET "perks" = array_remove("perks", '+20% Prestige progression'),
       "updated_at" = now()
 WHERE "perks" @> ARRAY['+20% Prestige progression'];
