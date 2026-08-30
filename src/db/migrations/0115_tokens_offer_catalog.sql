-- 0115: Grynd Shop — polished 5-offer token catalog + featured flag.
--
-- Self-healing reconciler: adds any columns/tables the later migrations and
-- application code depend on (some databases ran an earlier `token_packages`
-- seed that predates `bonus_tokens` / `featured` / `token_transactions` /
-- the checkout reconciliation ids), THEN reshapes the catalog to the final
-- Shop offers: Starter / Small / Medium / Large / Mega.
--
-- Everything is idempotent (ADD COLUMN IF NOT EXISTS, CREATE [TYPE/TABLE/
-- INDEX] IF NOT EXISTS / guarded enum, upsert on `key`, legacy keys turned
-- off) so it is safe to run repeatedly.

-- ── Schema reconciliation (missing on databases that ran the first seed) ──
ALTER TABLE "token_packages"
  ADD COLUMN IF NOT EXISTS "bonus_tokens" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "token_packages"
  ADD COLUMN IF NOT EXISTS "featured" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "stripe_checkout_sessions"
  ADD COLUMN IF NOT EXISTS "payment_intent_id" varchar(255);
--> statement-breakpoint
ALTER TABLE "stripe_checkout_sessions"
  ADD COLUMN IF NOT EXISTS "customer_id" varchar(255);
--> statement-breakpoint

-- token_transactions history table (with a guarded enum; only create the type
-- if it doesn't already exist).
DO $$
BEGIN
  CREATE TYPE token_transaction_type AS ENUM ('purchase', 'spend', 'refund');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_transactions" (
  "id" serial PRIMARY KEY NOT NULL,
  "clerk_id" varchar(255) NOT NULL,
  "type" token_transaction_type NOT NULL,
  "amount" bigint NOT NULL,
  "reference_type" varchar(40),
  "reference_id" varchar(128),
  "note" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_transactions_user_idx" ON "token_transactions" ("clerk_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_transactions_ref_idx" ON "token_transactions" ("reference_type", "reference_id");
--> statement-breakpoint

-- ── Reshape to the final 5-offer catalog ─────────────────────────────────
-- `token_amount` is the base award, `bonus_tokens` the on-top bonus; the
-- customer receives base + bonus. `featured` marks the recommended / best-value
-- card (Large here) — cosmetic only.
INSERT INTO "token_packages" ("key", "name", "token_amount", "bonus_tokens", "price_cents", "badge", "enabled", "featured", "sort_order")
VALUES
  ('starter', 'Starter',   500,    0,     499,  NULL,         true, false, 1),
  ('small',   'Small',    1200,    0,     999,  NULL,         true, false, 2),
  ('medium',  'Medium',   2500,  300,    1999,  NULL,         true, false, 3),
  ('large',   'Large',    6000, 1000,    3999,  'Most popular', true, true, 4),
  ('mega',    'Mega',    15000, 3000,    8999,  NULL,         true, false, 5)
ON CONFLICT ("key") DO UPDATE SET
  "name"          = EXCLUDED."name",
  "token_amount"  = EXCLUDED."token_amount",
  "bonus_tokens"  = EXCLUDED."bonus_tokens",
  "price_cents"   = EXCLUDED."price_cents",
  "badge"         = EXCLUDED."badge",
  "featured"      = EXCLUDED."featured",
  "sort_order"    = EXCLUDED."sort_order";
--> statement-breakpoint

-- Only one offer is marked featured at a time. (Order matters: set the chosen
-- one true first, then clear any others.)
UPDATE "token_packages" SET "featured" = false WHERE "key" <> 'large';
UPDATE "token_packages" SET "featured" = true  WHERE "key" = 'large';
--> statement-breakpoint

-- Legacy offers from the earlier seed that are no longer sold.
UPDATE "token_packages"
  SET "enabled" = false
  WHERE "key" IN ('popular', 'big');
--> statement-breakpoint