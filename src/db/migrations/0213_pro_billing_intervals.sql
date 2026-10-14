-- 0213_pro_billing_intervals.sql
--
-- GRYND PRO gains THREE recurring billing options (weekly / monthly / yearly),
-- all granting exactly the same `pro` entitlement. This migration only widens
-- the catalog and the subscription mirror so the per-interval Stripe Price ids
-- have somewhere to live. It creates NO remote Stripe objects (the idempotent
-- sync in src/lib/stripe/subscriptions.ts does that at runtime) and it changes
-- no existing subscription row's lifecycle.
--
--   1. `token_subscription_plans.stripe_price_id_weekly` /
--      `stripe_price_id_yearly` — the two NEW interval prices attached to the
--      SAME product. The existing `stripe_price_id` column is deliberately left
--      in place and keeps meaning "the monthly price", so the active monthly
--      subscription path, every historical row and every existing test read
--      exactly as before.
--
--   2. `token_subscriptions.billing_interval` — which option a live
--      subscription is on (weekly | monthly | yearly). DISPLAY ONLY: the
--      entitlement is still derived solely from `status` + the Stripe
--      subscription, never from this column.
--
-- Additive and idempotent: safe to re-run, and every pre-existing row keeps
-- working with a NULL interval until the next subscription webhook fills it in.

ALTER TABLE "token_subscription_plans"
  ADD COLUMN IF NOT EXISTS "stripe_price_id_weekly" varchar(255);
--> statement-breakpoint
ALTER TABLE "token_subscription_plans"
  ADD COLUMN IF NOT EXISTS "stripe_price_id_yearly" varchar(255);
--> statement-breakpoint
ALTER TABLE "token_subscriptions"
  ADD COLUMN IF NOT EXISTS "billing_interval" varchar(16);
--> statement-breakpoint

-- Backfill for members who subscribed before intervals existed. Every
-- subscription that could have been created up to now was MONTHLY (monthly was
-- the only recurring price the catalog ever sold), so this label is accurate
-- and it lets the upgrade page show an existing member their real interval
-- immediately instead of a generic "current plan". It only fills NULLs, so a
-- re-run is a no-op and no live row is ever re-labelled.
UPDATE "token_subscriptions"
  SET "billing_interval" = 'monthly'
  WHERE "billing_interval" IS NULL;
