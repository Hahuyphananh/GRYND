-- 0135: Official Grynd profile banner cosmetics.
--
-- `users.profile_banner` is intentionally retained for compatibility with old
-- data, but it is no longer read or written by the application. Existing
-- arbitrary URLs are not converted into official ownership.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "selected_banner" VARCHAR(120);

CREATE TABLE IF NOT EXISTS "banners" (
  "id" SERIAL PRIMARY KEY,
  "key" VARCHAR(120) NOT NULL UNIQUE,
  "name" VARCHAR(255) NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "asset_path" TEXT NOT NULL,
  "rarity" VARCHAR(40) NOT NULL DEFAULT 'Common',
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "user_banners" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "banner_key" VARCHAR(120) NOT NULL,
  "unlocked_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_banners_user_banner_unique" UNIQUE ("user_id", "banner_key")
);

CREATE INDEX IF NOT EXISTS "user_banners_user_idx"
  ON "user_banners" ("user_id", "banner_key");

-- Metadata only. The artwork is deliberately supplied in a later deployment.
INSERT INTO "banners" ("key", "name", "description", "asset_path", "rarity", "enabled", "sort_order")
VALUES (
  'neon-grid',
  'Neon Grid',
  'A clean electric grid for your Grynd profile.',
  '/banners/neon-grid.webp',
  'Common',
  TRUE,
  1
)
ON CONFLICT ("key") DO NOTHING;
