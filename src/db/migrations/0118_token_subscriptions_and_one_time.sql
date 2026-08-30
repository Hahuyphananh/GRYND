-- 0118: One-time purchase limit + Grynd+ token subscriptions.
--
-- Two additions to the virtual-token economy:
--
--   1) `token_packages.one_time` — flags offers that can only be purchased
--      once per user. Enforced server-side in /api/stripe/checkout against
--      the fulfilled `stripe_checkout_sessions` ledger, and the Shop hides
--      the buy button after the first purchase.
--   2) Token subscriptions (Grynd+) — recurring monthly token grants backed
--      by Stripe Billing:
--        * token_subscription_plans   — catalog of subscription offers
--          (name, monthly token grant, price). Mirrors token_packages.
--        * token_subscriptions        — one row per Stripe subscription with
--          its lifecycle status (active / trialing / past_due / canceled …).
--        * token_subscription_credits — per-invoice grant ledger; the UNIQUE
--          stripe_invoice_id makes monthly credits idempotent (a replayed
--          `invoice.paid` webhook can never double-credit).
-- All idempotent — safe to run repeatedly.

-- ── One-time-only offer flag ─────────────────────────────────────────────
ALTER TABLE "token_packages"
  ADD COLUMN IF NOT EXISTS "one_time" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "token_packages" SET "one_time" = true WHERE "key" = 'own';
--> statement-breakpoint

-- Mark the checkout ledger with the session mode so /api/stripe/session-status
-- can distinguish subscription sessions (grants happen per invoice, so a
-- subscription session reports fulfilled from the subscription row, not a
-- one-time token credit).
ALTER TABLE "stripe_checkout_sessions"
  ADD COLUMN IF NOT EXISTS "session_mode" varchar(20) NOT NULL DEFAULT 'payment';
--> statement-breakpoint

-- ── token_subscription_plans catalog ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "token_subscription_plans" (
  "id" serial PRIMARY KEY NOT NULL,
  "key" varchar(120) NOT NULL,
  "name" varchar(255) NOT NULL,
  "monthly_tokens" bigint NOT NULL,
  "price_cents" integer NOT NULL,
  "stripe_product_id" varchar(255),
  "stripe_price_id" varchar(255),
  "badge" varchar(40),
  "enabled" boolean NOT NULL DEFAULT true,
  "featured" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "token_subscription_plans_key_unique" UNIQUE ("key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_subscription_plans_sort_idx"
  ON "token_subscription_plans" ("enabled", "sort_order");
--> statement-breakpoint

-- ── token_subscriptions (per-user subscription lifecycle) ────────────────
CREATE TABLE IF NOT EXISTS "token_subscriptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "clerk_id" varchar(255) NOT NULL,
  "plan_key" varchar(120) NOT NULL,
  "stripe_subscription_id" varchar(255) NOT NULL,
  "customer_id" varchar(255),
  "status" varchar(30) NOT NULL DEFAULT 'active',
  "current_period_start" timestamp,
  "current_period_end" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "token_subscriptions_stripe_subscription_id_unique" UNIQUE ("stripe_subscription_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_subscriptions_clerk_idx"
  ON "token_subscriptions" ("clerk_id", "status");
--> statement-breakpoint

-- ── token_subscription_credits (idempotent per-invoice grants) ───────────
CREATE TABLE IF NOT EXISTS "token_subscription_credits" (
  "id" serial PRIMARY KEY NOT NULL,
  "clerk_id" varchar(255) NOT NULL,
  "plan_key" varchar(120) NOT NULL,
  "stripe_invoice_id" varchar(255) NOT NULL,
  "amount" bigint NOT NULL,
  "period_start" timestamp,
  "period_end" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "token_subscription_credits_stripe_invoice_id_unique" UNIQUE ("stripe_invoice_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_subscription_credits_clerk_idx"
  ON "token_subscription_credits" ("clerk_id", "created_at");
--> statement-breakpoint

-- ── RLS (same pattern as 0116: no direct client access) ──────────────────
ALTER TABLE "token_subscription_plans"   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "token_subscriptions"        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "token_subscription_credits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "token_tables_no_direct_client_access" ON "token_subscription_plans";
CREATE POLICY "token_tables_no_direct_client_access" ON "token_subscription_plans"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "token_tables_no_direct_client_access" ON "token_subscriptions";
CREATE POLICY "token_tables_no_direct_client_access" ON "token_subscriptions"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
DROP POLICY IF EXISTS "token_tables_no_direct_client_access" ON "token_subscription_credits";
CREATE POLICY "token_tables_no_direct_client_access" ON "token_subscription_credits"
  FOR ALL USING (false) WITH CHECK (false);
--> statement-breakpoint
REVOKE ALL ON "token_subscription_plans"   FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "token_subscriptions"        FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "token_subscription_credits" FROM PUBLIC;
--> statement-breakpoint

-- ── Seed the Grynd+ subscription plan ────────────────────────────────────
-- PLACEHOLDER values: monthly_tokens / price_cents are stand-ins until the
-- real Stripe product + price are attached. Point stripe_product_id /
-- stripe_price_id at the product created in the Dashboard (or let the code
-- auto-create one on first subscribe) and adjust monthly_tokens / price_cents
-- to the real grant and price. Upserts on `key`.
INSERT INTO "token_subscription_plans" ("key", "name", "monthly_tokens", "price_cents", "badge", "enabled", "featured", "sort_order")
VALUES ('grynd-plus', 'Grynd+', 5000, 999, 'Membership', true, false, 1)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
