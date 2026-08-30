-- 0113: Stripe virtual-token economy.
--
-- Backs the Stripe Checkout top-up flow. Tokens are NOT a second currency:
-- purchased tokens land in the existing `users.balance` column (numeric)
-- through the server-authoritative credit path.
--
-- Objects created (all idempotent — safe to run against any database):
--   * token_packages             — purchasable catalog; price + award resolved
--     server-side; admin-managed. Includes an optional bonus token award.
--   * stripe_checkout_sessions   — durable per-session ledger; session_id UNIQUE
--     for DB-level idempotency; stores the PaymentIntent/Customer ids needed for
--     reconciliation. `fulfilled` flips exactly once when tokens are credited.
--   * token_transactions         — durable history of every economy token change
--     (a row is written in the same transaction as the balance change).

-- ── token_packages catalog ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "token_packages" (
  "id" serial PRIMARY KEY NOT NULL,
  "key" varchar(120) NOT NULL,
  "name" varchar(255) NOT NULL,
  "token_amount" bigint NOT NULL,
  "bonus_tokens" bigint NOT NULL DEFAULT 0,
  "price_cents" integer NOT NULL,
  "stripe_price_id" varchar(255),
  "badge" varchar(40),
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "token_packages_key_unique" UNIQUE ("key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_packages_sort_idx" ON "token_packages" ("enabled", "sort_order");
--> statement-breakpoint

-- ── stripe_checkout_sessions ledger (durable idempotency + reconciliation) ──
CREATE TABLE IF NOT EXISTS "stripe_checkout_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "session_id" varchar(128) NOT NULL,
  "payment_intent_id" varchar(255),
  "customer_id" varchar(255),
  "clerk_id" varchar(255) NOT NULL,
  "package_key" varchar(120),
  "token_amount" bigint NOT NULL DEFAULT 0,
  "amount_cents" integer NOT NULL,
  "currency" varchar(3) NOT NULL DEFAULT 'usd',
  "payment_status" varchar(30) NOT NULL DEFAULT 'open',
  "fulfilled" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "stripe_checkout_sessions_session_id_unique" UNIQUE ("session_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_checkout_sessions_clerk_idx" ON "stripe_checkout_sessions" ("clerk_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_checkout_sessions_fulfilled_idx" ON "stripe_checkout_sessions" ("fulfilled", "session_id");
--> statement-breakpoint

-- ── token_transactions history (auditable record of every economy token change) ──
CREATE TYPE token_transaction_type AS ENUM ('purchase', 'spend', 'refund');
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

-- ── Seed the default package catalog (safe to re-run). ──────────────────
INSERT INTO "token_packages" ("key", "name", "token_amount", "bonus_tokens", "price_cents", "badge", "enabled", "sort_order")
VALUES
  ('starter', 'Starter',            500,  0,    499,  NULL,         true, 1),
  ('popular', 'Popular',           1000, 200,   999,  'Most popular', true, 2),
  ('big',     'Big',               2500, 500,  1999,  NULL,         true, 3),
  ('mega',    'Mega',              6000,1500,  4999,  NULL,         true, 4)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint