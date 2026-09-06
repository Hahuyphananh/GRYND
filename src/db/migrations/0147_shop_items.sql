-- 0147: Token-priced consumable item shop.
--
-- The economy needed a token sink (see the payments audit): tokens only left
-- circulation through lost wagers, and the ok dormant `spend` ledger type in
-- token_transactions was designed for exactly this but never written. This
-- migration adds the inventory + timed-effect tables the shop writes to.
--
--   * user_items         — consumable inventory (qty per item per user).
--                          Auto-consumed by game hooks (e.g. a streak shield
--                          is spent when a daily streak would reset).
--   * user_item_effects  — active timed boosts (e.g. 2× battlepass XP for
--                          24h). One row per active effect, with an expiry;
--                          a repurchase EXTENDS the window rather than
--                          stacking a second row.
--
-- Purchases are token-only: the buy route debits users.balance and writes a
-- `spend` row to token_transactions in the same transaction. Items have no
-- cash value and are never refundable to real money.

CREATE TABLE IF NOT EXISTS "user_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "item_key" varchar(64) NOT NULL,
  "qty" integer NOT NULL DEFAULT 0,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_items_user_item_unique" UNIQUE ("user_id", "item_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_items_user_idx" ON "user_items" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_item_effects" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "effect_key" varchar(64) NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_item_effects_user_effect_unique" UNIQUE ("user_id", "effect_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_item_effects_user_idx" ON "user_item_effects" ("user_id");