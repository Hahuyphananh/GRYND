-- 0114: Persist real Stripe Product ids on token packages.
--
-- Adds `stripe_product_id` so each token package can be backed by a real
-- Stripe Product + one-time Price (created lazily by src/lib/stripe/packages.ts
-- on first purchase, or proactively via the admin sync route). Idempotent.

ALTER TABLE "token_packages"
  ADD COLUMN IF NOT EXISTS "stripe_product_id" varchar(255);
--> statement-breakpoint