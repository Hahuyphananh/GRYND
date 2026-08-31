-- 0128: Official Grynd icon system.
--
-- Replaces arbitrary user-uploaded profile pictures / external avatar URLs
-- with official Grynd ICONS. A user owns one or more official icons
-- (tracks in `user_icons`) and equips exactly one (users.selected_icon).
-- Avatars are rendered only from the official catalog (`icons`) — never from
-- user-provided media. `price_tokens` is reserved for a future token shop
-- (purchases not implemented yet).
--
-- Idempotent: safe to run repeatedly.

-- 1) Equipped icon on users. Defaults to the official default icon key so
--    every existing user immediately has a valid selected icon.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "selected_icon" VARCHAR(120) DEFAULT 'default';

-- Backfill any NULL/invalid selections to the default (defensive).
UPDATE "users" SET "selected_icon" = 'default' WHERE "selected_icon" IS NULL;

-- 2) Official icon catalog (mirrors `special_titles`).
CREATE TABLE IF NOT EXISTS "icons" (
  "id" SERIAL PRIMARY KEY,
  "key" VARCHAR(120) NOT NULL UNIQUE,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "asset_path" TEXT NOT NULL,
  "rarity" VARCHAR(40) NOT NULL DEFAULT 'Common',
  "price_tokens" INTEGER,
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "is_default" BOOLEAN NOT NULL DEFAULT FALSE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 3) Ownership join (mirrors `user_special_titles`): prevents owning the
--    same icon twice.
CREATE TABLE IF NOT EXISTS "user_icons" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "icon_key" VARCHAR(120) NOT NULL,
  "unlocked_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_icons_user_icon_idx"
  ON "user_icons" ("user_id", "icon_key");

-- 4) Chat avatar: store the sender's official icon key (legacy
--    `profile_image_url` column is left intact for back-compat but is never
--    rendered as a live avatar; old rows with NULL icon_key show the default).
ALTER TABLE "chat_messages"
  ADD COLUMN IF NOT EXISTS "icon_key" TEXT;

-- 5) Seed the official default icon. Asset path follows the stable
--    convention `/icons/<key>.webp` used by src/lib/iconAssets.ts. The
--    actual artwork file is added later (see public/icons/README.md).
INSERT INTO "icons" ("key", "name", "description", "asset_path", "rarity", "price_tokens", "enabled", "is_default", "sort_order")
VALUES ('default', 'Default', 'The official default Grynd icon.', '/icons/default.webp', 'Common', NULL, TRUE, TRUE, 0)
ON CONFLICT ("key") DO NOTHING;

-- 6) Backfill ownership: every existing user owns the official default icon
--    (new users are granted it programmatically on account creation).
INSERT INTO "user_icons" ("user_id", "icon_key")
SELECT u."id", 'default'
FROM "users" u
WHERE NOT EXISTS (
  SELECT 1 FROM "user_icons" ui WHERE ui."user_id" = u."id" AND ui."icon_key" = 'default'
);