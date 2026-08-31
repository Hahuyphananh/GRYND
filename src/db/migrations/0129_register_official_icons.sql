-- 0129: Register the 12 official Grynd icon artworks + grant to all users.
--
-- The artwork (1024x1024 PNG masters) lives in src/images/gryndicon1..12.png;
-- the production 512x512 WebP assets are generated into public/icons/ by
-- scripts/generate-icon-assets.mjs and served at /icons/<key>.webp.
--
-- This migration:
--   1. Inserts the 12 official icons into the `icons` catalog (enabled,
--      not the default, no shop price yet — price_tokens stays NULL).
--   2. Grants every existing user ownership of all 12 via `user_icons`
--      (new users are granted them programmatically at account creation).
--
-- Idempotent: safe to run repeatedly.

INSERT INTO "icons" ("key", "name", "description", "asset_path", "rarity", "price_tokens", "enabled", "is_default", "sort_order")
VALUES
  ('gryndicon1',  'Grynd Icon 1',  'Official Grynd icon artwork 1.',  '/icons/gryndicon1.webp',  'Common', NULL, TRUE, FALSE, 1),
  ('gryndicon2',  'Grynd Icon 2',  'Official Grynd icon artwork 2.',  '/icons/gryndicon2.webp',  'Common', NULL, TRUE, FALSE, 2),
  ('gryndicon3',  'Grynd Icon 3',  'Official Grynd icon artwork 3.',  '/icons/gryndicon3.webp',  'Common', NULL, TRUE, FALSE, 3),
  ('gryndicon4',  'Grynd Icon 4',  'Official Grynd icon artwork 4.',  '/icons/gryndicon4.webp',  'Common', NULL, TRUE, FALSE, 4),
  ('gryndicon5',  'Grynd Icon 5',  'Official Grynd icon artwork 5.',  '/icons/gryndicon5.webp',  'Common', NULL, TRUE, FALSE, 5),
  ('gryndicon6',  'Grynd Icon 6',  'Official Grynd icon artwork 6.',  '/icons/gryndicon6.webp',  'Common', NULL, TRUE, FALSE, 6),
  ('gryndicon7',  'Grynd Icon 7',  'Official Grynd icon artwork 7.',  '/icons/gryndicon7.webp',  'Common', NULL, TRUE, FALSE, 7),
  ('gryndicon8',  'Grynd Icon 8',  'Official Grynd icon artwork 8.',  '/icons/gryndicon8.webp',  'Common', NULL, TRUE, FALSE, 8),
  ('gryndicon9',  'Grynd Icon 9',  'Official Grynd icon artwork 9.',  '/icons/gryndicon9.webp',  'Common', NULL, TRUE, FALSE, 9),
  ('gryndicon10', 'Grynd Icon 10', 'Official Grynd icon artwork 10.', '/icons/gryndicon10.webp', 'Common', NULL, TRUE, FALSE, 10),
  ('gryndicon11', 'Grynd Icon 11', 'Official Grynd icon artwork 11.', '/icons/gryndicon11.webp', 'Common', NULL, TRUE, FALSE, 11),
  ('gryndicon12', 'Grynd Icon 12', 'Official Grynd icon artwork 12.', '/icons/gryndicon12.webp', 'Common', NULL, TRUE, FALSE, 12)
ON CONFLICT ("key") DO NOTHING;

-- Grant all 12 to every existing user (idempotent per (user_id, icon_key)).
INSERT INTO "user_icons" ("user_id", "icon_key")
SELECT u."id", k."key"
FROM "users" u
CROSS JOIN (
  VALUES
    ('gryndicon1'), ('gryndicon2'), ('gryndicon3'), ('gryndicon4'),
    ('gryndicon5'), ('gryndicon6'), ('gryndicon7'), ('gryndicon8'),
    ('gryndicon9'), ('gryndicon10'), ('gryndicon11'), ('gryndicon12')
) AS k("key")
WHERE NOT EXISTS (
  SELECT 1 FROM "user_icons" ui WHERE ui."user_id" = u."id" AND ui."icon_key" = k."key"
);
