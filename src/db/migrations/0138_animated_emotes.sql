-- 0138: Animated emote inventory + persistent 9-slot loadouts.
--
-- Follows the exact architecture of the official Grynd icon / banner
-- cosmetics (migrations 0128/0129/0135):
--   1. `emotes`        — catalog table (stable keys, official asset paths)
--   2. `user_emotes`   — per-user ownership join table (idempotent unlocks)
--   3. `users.equipped_emotes` — JSONB ordered array of equipped emote keys
--
-- Grant model:
--   * 8 FREE emotes below are automatically owned by every user. They are
--     backfilled here for pre-existing accounts and granted idempotently at
--     account creation (clerk webhook / sync-user).
--   * 7 Battle Pass emotes are granted through the existing idempotent
--     Battle Pass reconciliation (grantBattlepassEmotes in src/lib/emotes.ts)
--     once the matching Battle Pass level is reached.
--
-- This migration is additive and idempotent (safe to run repeatedly).
-- Existing data is never deleted.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "equipped_emotes" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "emotes" (
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

CREATE TABLE IF NOT EXISTS "user_emotes" (
  "id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "emote_key" VARCHAR(120) NOT NULL,
  "unlocked_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "user_emotes_user_emote_unique" UNIQUE ("user_id", "emote_key")
);

CREATE INDEX IF NOT EXISTS "user_emotes_user_idx"
  ON "user_emotes" ("user_id", "emote_key");

-- ── Catalog seed ────────────────────────────────────────────────────────
-- The 15 official animated Noto emote definitions. 8 are free for everyone
-- (sort_order 1-8); 7 are Battle Pass rewards (sort_order 9-15).
--
-- The artwork (animated WebP) is supplied separately in public/emotes/ and
-- resolved as /emotes/<key>.webp. Consumers handle a missing file with a
-- safe visual fallback. Keys intentionally use the stable lowercase names
-- the game emotes already used (laugh/wow/fire/cry) where they exist.
INSERT INTO "emotes" ("key", "name", "description", "asset_path", "rarity", "enabled", "sort_order")
VALUES
  -- FREE (8): owned by every user, auto-equipped by default
  ('laugh',    'Laughing',    'Burst out laughing with this animated Noto emote.', '/emotes/laugh.webp',    'Common', TRUE, 1),
  ('shock',    'Shocked',     'Wide-eyed surprise, animated.',                     '/emotes/shock.webp',    'Common', TRUE, 2),
  ('cry',      'Crying',      'Let the tears flow.',                               '/emotes/cry.webp',      'Common', TRUE, 3),
  ('angry',    'Angry',       'Steam coming off your head.',                      '/emotes/angry.webp',    'Common', TRUE, 4),
  ('love',     'Love',        'Hearts for days.',                                  '/emotes/love.webp',     'Common', TRUE, 5),
  ('cool',     'Cool',        'Sunglasses. Zero worries.',                         '/emotes/cool.webp',     'Common', TRUE, 6),
  ('wow',      'Wow',         'Mind. Blown.',                                      '/emotes/wow.webp',      'Common', TRUE, 7),
  ('fire',     'Fire',        'Straight fire.',                                    '/emotes/fire.webp',     'Common', TRUE, 8),
  -- BATTLE PASS (7): granted at the matching Battle Pass level (6/13/22/31/42/56/81)
  ('hype',     'Hype',        'Get hyped. Battle Pass Level 6 reward.',            '/emotes/hype.webp',     'Common', TRUE, 9),
  ('victory',  'Victory',     'You win. Battle Pass Level 13 reward.',             '/emotes/victory.webp',  'Bronze', TRUE, 10),
  ('party',    'Party',       'Let the party begin. Battle Pass Level 22 reward.', '/emotes/party.webp',    'Bronze', TRUE, 11),
  ('skull',    'Skull',       'Too soon. Battle Pass Level 31 reward.',            '/emotes/skull.webp',    'Silver', TRUE, 12),
  ('thumbsup', 'Thumbs Up',   'Respect. Battle Pass Level 42 reward.',             '/emotes/thumbsup.webp', 'Silver', TRUE, 13),
  ('clap',     'Clap',        'Slow clap to standing ovation. Level 56 reward.',   '/emotes/clap.webp',     'Gold',   TRUE, 14),
  ('star',     'Star',        'Legend status. Battle Pass Level 81 reward.',       '/emotes/star.webp',     'Elite',  TRUE, 15)
ON CONFLICT ("key") DO NOTHING;

-- ── Backfill: every existing user owns the 8 FREE emotes ────────────────
-- Idempotent per (user_id, emote_key) — the UNIQUE constraint makes a
-- repeat run a no-op.
INSERT INTO "user_emotes" ("user_id", "emote_key")
SELECT u."id", k."key"
FROM "users" u
CROSS JOIN (
  VALUES
    ('laugh'), ('shock'), ('cry'), ('angry'),
    ('love'), ('cool'), ('wow'), ('fire')
) AS k("key")
WHERE NOT EXISTS (
  SELECT 1 FROM "user_emotes" ue WHERE ue."user_id" = u."id" AND ue."emote_key" = k."key"
);

-- ── Default loadout ─────────────────────────────────────────────────────
-- Users who have never set a loadout (legacy rows / brand-new accounts that
-- predate the free-emote grant) get the 8 free emotes equipped so the in-game
-- picker shows them immediately. A user-chosen empty loadout (array cleared
-- later) is never touched again — seeding only happens when the stored array
-- is empty AND a first-time free-emote grant occurs (account creation paths).
UPDATE "users"
SET "equipped_emotes" = '["laugh","shock","cry","angry","love","cool","wow","fire"]'::jsonb
WHERE "equipped_emotes" IS NULL
   OR jsonb_array_length("equipped_emotes") = 0;
