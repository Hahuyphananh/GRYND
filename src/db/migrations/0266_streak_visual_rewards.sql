-- 0266: streak-earned profile glows and username effects.
--
-- These are CATALOG entries only: no artwork, no external asset URLs. Each
-- visual is a CSS class shipped in src/app/globals.css (gradient text or a
-- box-shadow aura), so the browser paints it with the same primitives as the
-- existing profile effects.
--
-- `streak_only = TRUE` keeps every row out of grantAllCosmeticsToUser; the
-- permanent `user_unlocks` row written by the daily streak is the ownership
-- authority, and the server mirrors it into `user_cosmetics` on the milestone
-- completion so the existing picker/equip flow sees it immediately.
--
-- Idempotent and additive: ON CONFLICT updates the catalog definition without
-- touching ownership.

INSERT INTO "cosmetics"
  ("key", "name", "description", "category", "rarity", "visual",
   "price_tokens", "unlock_condition", "enabled", "sort_order",
   "pro_only", "streak_only", "unlock_streak_day")
VALUES
  (
    'glow_streak_ember',
    'Ember Profile Glow',
    'A warm amber halo earned at a 14-day streak.',
    'profile_glow',
    'Common',
    '{"cssClass":"streak-glow-ember","color":"#f59e0b"}'::jsonb,
    NULL, NULL, TRUE, 703, FALSE, TRUE, 14
  ),
  (
    'username_streak_emerald',
    'Emerald Name Glow',
    'A green-gold name shimmer earned at a 30-day streak.',
    'username_effect',
    'Rare',
    '{"cssClass":"streak-name-emerald","color":"#34d399"}'::jsonb,
    NULL, NULL, TRUE, 704, FALSE, TRUE, 30
  ),
  (
    'glow_streak_frost',
    'Frost Profile Glow',
    'A cool cyan halo earned at a 60-day streak.',
    'profile_glow',
    'Rare',
    '{"cssClass":"streak-glow-frost","color":"#67e8f9"}'::jsonb,
    NULL, NULL, TRUE, 705, FALSE, TRUE, 60
  ),
  (
    'username_streak_centurion',
    'Centurion Name Flare',
    'A brass-and-ivory name flare earned at a 100-day streak.',
    'username_effect',
    'Epic',
    '{"cssClass":"streak-name-centurion","color":"#e0bd6d"}'::jsonb,
    NULL, NULL, TRUE, 706, FALSE, TRUE, 100
  ),
  (
    'glow_streak_electric',
    'Electric Profile Glow',
    'A pulsing cyan-violet halo earned at a 180-day streak.',
    'profile_glow',
    'Epic',
    '{"cssClass":"streak-glow-electric","color":"#38bdf8"}'::jsonb,
    NULL, NULL, TRUE, 707, FALSE, TRUE, 180
  ),
  (
    'username_streak_crimson',
    'Crimson Name Signature',
    'A deep crimson name shimmer earned at a 275-day streak.',
    'username_effect',
    'Legendary',
    '{"cssClass":"streak-name-crimson","color":"#e11d48"}'::jsonb,
    NULL, NULL, TRUE, 708, FALSE, TRUE, 275
  ),
  (
    'glow_streak_eternal',
    'Eternal Profile Corona',
    'A black-and-gold corona for a full year.',
    'profile_glow',
    'Legendary',
    '{"cssClass":"streak-glow-eternal","color":"#c9a24a"}'::jsonb,
    NULL, NULL, TRUE, 709, FALSE, TRUE, 365
  )
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "rarity" = EXCLUDED."rarity",
  "visual" = EXCLUDED."visual",
  "price_tokens" = NULL,
  "unlock_condition" = NULL,
  "enabled" = TRUE,
  "sort_order" = EXCLUDED."sort_order",
  "streak_only" = TRUE,
  "unlock_streak_day" = EXCLUDED."unlock_streak_day";
