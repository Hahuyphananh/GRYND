-- 0149: Name glow system.
--
-- Battlepass "Name Glow" rewards (type `color` on the track) become real,
-- claimable cosmetics. A user owns one or more name glows (`user_glows`)
-- and equips exactly one (users.selected_glow); the equipped glow's color
-- renders on their name in chat (outranking the Grynd+ free-form chat
-- color when both are set).
--
-- Mirrors the icons / banners ownership pattern: a catalog table, a
-- per-user ownership join table, and an equipped-item column on `users`.
-- `price_tokens` is reserved for a future token shop (NULL = not for sale).
--
-- Idempotent: safe to run repeatedly.

-- 1) Equipped glow on users. NULL = no glow equipped (default state).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "selected_glow" VARCHAR(120);

-- 2) Name glow catalog. `color` is the hex value rendered on the name.
CREATE TABLE IF NOT EXISTS "glows" (
  "id" SERIAL PRIMARY KEY,
  "key" VARCHAR(120) NOT NULL UNIQUE,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "color" VARCHAR(7) NOT NULL,
  "rarity" VARCHAR(40) NOT NULL DEFAULT 'Common',
  "price_tokens" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "is_default" BOOLEAN NOT NULL DEFAULT FALSE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 3) Ownership join (mirrors `user_icons`): prevents owning the same glow
--    twice.
CREATE TABLE IF NOT EXISTS "user_glows" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "glow_key" VARCHAR(120) NOT NULL,
  "unlocked_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_glows_user_glow_idx"
  ON "user_glows" ("user_id", "glow_key");

-- 4) Seed the 23 battlepass glow rewards. Keys must match the `key` on the
--    `color` rewards in src/lib/battlepassRewards.js so claims resolve.
INSERT INTO "glows" ("key", "name", "description", "color", "rarity", "price_tokens", "enabled", "is_default", "sort_order")
VALUES
  ('cyan',        'Cyan Glow',        'Unlock the cyan name glow',        '#00e5ff', 'Common',   NULL, TRUE, FALSE, 1),
  ('lime',        'Lime Glow',        'Unlock the lime name glow',        '#a3e635', 'Common',   NULL, TRUE, FALSE, 2),
  ('violet',      'Violet Glow',      'Unlock the violet name glow',      '#a78bfa', 'Common',   NULL, TRUE, FALSE, 3),
  ('rose',        'Rose Glow',        'Unlock the rose name glow',        '#f472b6', 'Common',   NULL, TRUE, FALSE, 4),
  ('amber',       'Amber Glow',       'Unlock the amber name glow',       '#fbbf24', 'Common',   NULL, TRUE, FALSE, 5),
  ('emerald',     'Emerald Glow',     'Unlock the emerald name glow',     '#34d399', 'Common',   NULL, TRUE, FALSE, 6),
  ('crimson',     'Crimson Glow',     'Unlock the crimson name glow',     '#f87171', 'Common',   NULL, TRUE, FALSE, 7),
  ('sky',         'Sky Glow',         'Unlock the sky name glow',         '#38bdf8', 'Common',   NULL, TRUE, FALSE, 8),
  ('magenta',     'Magenta Glow',     'Unlock the magenta name glow',     '#e879f9', 'Common',   NULL, TRUE, FALSE, 9),
  ('ocean',       'Ocean Glow',       'Unlock the ocean name glow',       '#2dd4bf', 'Common',   NULL, TRUE, FALSE, 10),
  ('gold',        'Gold Glow',        'Unlock the gold name glow',        '#facc15', 'Common',   NULL, TRUE, FALSE, 11),
  ('platinum',    'Platinum Glow',    'Unlock the platinum name glow',    '#e2e8f0', 'Common',   NULL, TRUE, FALSE, 12),
  ('ruby',        'Ruby Glow',        'Unlock the ruby name glow',        '#fb7185', 'Common',   NULL, TRUE, FALSE, 13),
  ('royal',       'Royal Glow',       'Unlock the royal name glow',       '#818cf8', 'Common',   NULL, TRUE, FALSE, 14),
  ('sunfire',     'Sunfire Glow',     'Unlock the sunfire name glow',     '#fb923c', 'Common',   NULL, TRUE, FALSE, 15),
  ('golden_flame','Golden Flame',     'Unlock the golden flame name glow','#fde047', 'Common',   NULL, TRUE, FALSE, 16),
  ('aurora',      'Aurora Glow',      'Unlock the aurora name glow',      '#67e8f9', 'Common',   NULL, TRUE, FALSE, 17),
  ('inferno',     'Inferno Glow',     'Unlock the inferno name glow',     '#f97316', 'Common',   NULL, TRUE, FALSE, 18),
  ('nebula',      'Nebula Glow',      'Unlock the nebula name glow',      '#c084fc', 'Common',   NULL, TRUE, FALSE, 19),
  ('solar_flare', 'Solar Flare',      'Unlock the solar flare name glow', '#fdba74', 'Common',   NULL, TRUE, FALSE, 20),
  ('starfire',    'Starfire Glow',    'Unlock the starfire name glow',    '#fde68a', 'Common',   NULL, TRUE, FALSE, 21),
  ('celestial',   'Celestial Glow',   'Unlock the celestial name glow',   '#93c5fd', 'Common',   NULL, TRUE, FALSE, 22),
  ('golden_name', 'Golden Name Glow', 'Permanent golden name glow — the mark of a legend', '#f5ff3b', 'Overlord', NULL, TRUE, FALSE, 23)
ON CONFLICT ("key") DO NOTHING;