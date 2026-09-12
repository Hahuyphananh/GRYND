-- 0156: Final pack value ladder, membership tier perks, reward ledger type,
--       consumable/cosmetic foundation + RLS closure.
--
-- 1) One-time token packs — the value ladder is rebalanced so bigger packs
--    pay a better tokens-per-dollar rate (prices unchanged for Starter/Small/
--    Medium/Large). Mega moves $89.99 → $99.99 and gets more bonus tokens so
--    its rate (~1,300 tokens/$) stays a fair step above Large (~1,250/$):
--
--      starter  $4.99  →  5,000                  (~1,002 tokens/$)
--      small    $9.99  → 10,000 +   750 = 10,750 (~1,076 tokens/$)
--      medium  $19.99  → 20,000 + 3,000 = 23,000 (~1,151 tokens/$)
--      large   $39.99  → 40,000 +10,000 = 50,000 (~1,251 tokens/$)
--      mega    $99.99  → 90,000 +40,000 = 130,000 (~1,301 tokens/$)
--
--    The `own` legacy offer (a duplicate of Starter: $4.99 / 5,000) is
--    DISABLED for new purchases but its row + Stripe history are preserved.
--
-- 2) Membership tiers — upserts Pro / High Roller (and refreshes Grynd+)
--    with the full implemented perk list. Prices and monthly grants are
--    unchanged; perks copy now reflects tier-based XP multipliers, daily
--    quest slots, Prestige progression and the daily claim.
--
-- 3) `token_transaction_type` gains `reward` so Battle Pass token rewards
--    and other server-granted credits are ledged distinctly.
--
-- 4) Economy table RLS closure + cosmetics foundation:
--      * cosmetics catalog (frames / badges / avatar+username+chat effects /
--        profile glow / prestige effects), only rows with a price_tokens are
--        purchasable from the Shop,
--      * user_cosmetics ownership (server-written only),
--      * users.equipped_cosmetics jsonb (server-written only),
--      * RLS deny-on-all policies for the previously-unprotected economy
--        tables (user_items / user_item_effects / battlepass_claims) plus the
--        new cosmetics tables (same pattern as migration 0116 — the service
--        role bypasses, the client can never read/write directly).
-- Idempotent: safe to run repeatedly.
--> statement-breakpoint

-- ── 1) One-time token pack ladder ──────────────────────────────────────────
UPDATE "token_packages"
SET "token_amount" = 5000,  "bonus_tokens" = 0,     "price_cents" = 499,  "enabled" = true, "updated_at" = now()
WHERE "key" = 'starter';
--> statement-breakpoint
UPDATE "token_packages"
SET "bonus_tokens" = 750,  "updated_at" = now()
WHERE "key" = 'small';
--> statement-breakpoint
UPDATE "token_packages"
SET "bonus_tokens" = 3000, "updated_at" = now()
WHERE "key" = 'medium';
--> statement-breakpoint
UPDATE "token_packages"
SET "bonus_tokens" = 10000, "updated_at" = now()
WHERE "key" = 'large';
--> statement-breakpoint
UPDATE "token_packages"
SET "price_cents" = 9999, "bonus_tokens" = 40000, "updated_at" = now()
WHERE "key" = 'mega';
--> statement-breakpoint
UPDATE "token_packages"
SET "enabled" = false, "updated_at" = now()
WHERE "key" = 'own';
--> statement-breakpoint

-- ── 2) Membership tier perks ───────────────────────────────────────────────
INSERT INTO "token_subscription_plans"
  ("key", "name", "monthly_tokens", "price_cents", "badge", "enabled", "featured", "sort_order", "perks")
VALUES
  ('grynd-plus', 'Grynd+', 5000, 499, 'Membership', true, false, 1, ARRAY[
    '5,000 tokens / month',
    '1x Daily Streak Shield / month',
    '1x 3x XP Boost (48h) / month',
    '+15% XP',
    '+50% login reward bonus',
    'GRYND+ chat badge',
    'Priority matchmaking',
    'Ad-free experience'
  ]),
  ('grynd-pro', 'Grynd Pro', 12000, 999, 'Pro', true, false, 2, ARRAY[
    '12,000 tokens / month',
    '3x Daily Streak Shield / month',
    '1x 3x XP Boost (48h) / month',
    '+35% XP',
    '+1 daily quest slot (4 total)',
    'Daily bonus token drop',
    'GRYND PRO chat badge & title',
    'Enhanced profile customization',
    'Priority matchmaking',
    'Ad-free experience'
  ]),
  ('grynd-high-roller', 'Grynd High Roller', 26000, 1999, 'High Roller', true, true, 3, ARRAY[
    '26,000 tokens / month',
    '5x Daily Streak Shield / month',
    '2x 3x XP Boost (48h) / month',
    '+70% XP',
    '+2 daily quest slots (5 total)',
    '+20% Prestige progression',
    'Daily bonus token drop',
    'HIGH ROLLER chat badge & title',
    '+100% login reward (vs +50% base)',
    'Enhanced profile customization',
    'Priority matchmaking',
    'Ad-free experience'
  ])
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "monthly_tokens" = EXCLUDED."monthly_tokens",
  "price_cents" = EXCLUDED."price_cents",
  "badge" = EXCLUDED."badge",
  "enabled" = EXCLUDED."enabled",
  "featured" = EXCLUDED."featured",
  "sort_order" = EXCLUDED."sort_order",
  "perks" = EXCLUDED."perks",
  "updated_at" = now();
--> statement-breakpoint

-- ── 3) Reward ledger type ──────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'token_transaction_type' AND e.enumlabel = 'reward'
  ) THEN
    ALTER TYPE token_transaction_type ADD VALUE 'reward';
  END IF;
END $$;
--> statement-breakpoint

-- ── 4a) Cosmetics catalog ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "cosmetics" (
  "id" serial PRIMARY KEY NOT NULL,
  "key" varchar(120) NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "category" varchar(40) NOT NULL,
  "rarity" varchar(40) NOT NULL DEFAULT 'Common',
  "price_tokens" integer,
  "visual" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "unlock_condition" varchar(40),
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "cosmetics_key_unique" UNIQUE ("key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cosmetics_catalog_idx" ON "cosmetics" ("enabled", "category", "sort_order");
--> statement-breakpoint

-- ── 4b) Cosmetic ownership ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_cosmetics" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "cosmetic_key" varchar(120) NOT NULL,
  "source" varchar(40) NOT NULL DEFAULT 'shop',
  "unlocked_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "user_cosmetics_user_key_unique" UNIQUE ("user_id", "cosmetic_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_cosmetics_user_idx" ON "user_cosmetics" ("user_id");
--> statement-breakpoint

-- ── 4c) Equipped cosmetics (server-written only) ───────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "equipped_cosmetics" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

-- ── 4d) RLS — economy closure + new tables ─────────────────────────────────
ALTER TABLE "user_items"         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_item_effects"  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "battlepass_claims"  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cosmetics"          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user_cosmetics"     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "no_direct_client_access" ON "user_items";
CREATE POLICY "no_direct_client_access" ON "user_items"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "no_direct_client_access" ON "user_item_effects";
CREATE POLICY "no_direct_client_access" ON "user_item_effects"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "no_direct_client_access" ON "battlepass_claims";
CREATE POLICY "no_direct_client_access" ON "battlepass_claims"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "no_direct_client_access" ON "cosmetics";
CREATE POLICY "no_direct_client_access" ON "cosmetics"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "no_direct_client_access" ON "user_cosmetics";
CREATE POLICY "no_direct_client_access" ON "user_cosmetics"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
REVOKE ALL ON "user_items"        FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "user_item_effects" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "battlepass_claims" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "cosmetics"         FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "user_cosmetics"    FROM PUBLIC;
--> statement-breakpoint

-- ── 4e) Seed cosmetics ─────────────────────────────────────────────────────
INSERT INTO "cosmetics" ("key", "name", "description", "category", "rarity", "price_tokens", "visual", "unlock_condition", "enabled", "sort_order")
VALUES
  ('frame-neon-edge',  'Neon Edge Frame',   'A cyan neon frame around your profile avatar.',  'profile_frame',  'Common',   600,  '{"cssClass":"frame-neon-edge","color":"#22d3ee"}',                 NULL,             true, 1),
  ('frame-platinum',   'Platinum Frame',    'A bright platinum-plated profile frame.',         'profile_frame',  'Rare',    1500,  '{"cssClass":"frame-platinum","color":"#cdd6f4"}',                  NULL,             true, 2),
  ('frame-inferno',    'Inferno Frame',     'A smoldering fire frame for serious wagerers.',   'profile_frame',  'Epic',    3000,  '{"cssClass":"frame-inferno","color":"#f97316"}',                   NULL,             true, 3),
  ('badge-grynd-og',   'GRYND OG',          'Earned the old-school way. Show it off.',         'badge',          'Common',   500,  '{"cssClass":"badge-grynd-og","color":"#fbbf24"}',                  NULL,             true, 4),
  ('badge-veteran',    'Battle Pass Vet',   'Conquered the Battle Pass. Twice or more.',       'badge',          'Rare',    1200,  '{"cssClass":"badge-veteran","color":"#a78bfa"}',                   NULL,             true, 5),
  ('avatar-pulse',     'Status Pulse',      'A steady pulse behind your avatar.',              'avatar_effect',  'Rare',     900,  '{"cssClass":"avatar-pulse","color":"#34d399"}',                    NULL,             true, 6),
  ('avatar-soft-aura', 'Soft Aura',         'Gentle ambient glow around your avatar.',         'avatar_effect',  'Common',   450,  '{"cssClass":"avatar-soft-aura","color":"#818cf8"}',                NULL,             true, 7),
  ('username-shimmer', 'Shimmer Name',      'Your name plays a shimmering gradient.',          'username_effect','Rare',    1200,  '{"cssClass":"username-shimmer","color":"#fbbf24"}',                NULL,             true, 8),
  ('chat-shimmer',     'Legend Chat Name',  'Golden shimmer on your chat name.',               'chat_effect',    'Epic',    2500,  '{"cssClass":"chat-shimmer","color":"#f59e0b"}',                    NULL,             true, 9),
  ('profile-aura',     'Profile Aura',      'A soft aura ringing the whole profile card.',     'profile_glow',   'Rare',    1200,  '{"cssClass":"profile-aura","color":"#10b981"}',                    NULL,             true, 10),
  ('prestige-aura',    'Prestige Aura',     'The unmistakable aura of a prestige player.',     'prestige_effect','Elite',    NULL,  '{"cssClass":"prestige-aura","color":"#8b5cf6"}',                   'prestige',       true, 11),
  ('prestige-crown',   'Prestige Crown',    'A crown floating above a true veteran profile.',  'prestige_effect','Legendary', NULL, '{"cssClass":"prestige-crown","color":"#f59e0b"}',                   'prestige',       true, 12)
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "category" = EXCLUDED."category",
  "rarity" = EXCLUDED."rarity",
  "price_tokens" = EXCLUDED."price_tokens",
  "visual" = EXCLUDED."visual",
  "unlock_condition" = EXCLUDED."unlock_condition",
  "enabled" = EXCLUDED."enabled",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = now();
--> statement-breakpoint