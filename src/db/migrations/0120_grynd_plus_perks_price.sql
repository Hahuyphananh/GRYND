-- 0120: Grynd+ — real price ($4.99/mo) + perks attribute.
--
-- `price_cents` is the fallback/ledger value (the displayed price resolves
-- live from the Stripe price); set to the real 499 ($4.99). `perks` is the
-- benefit list the Shop renders on the membership card — sales copy first,
-- each perk gets implemented behind the active-subscription check.
-- Idempotent: safe to run repeatedly.

ALTER TABLE "token_subscription_plans"
  ADD COLUMN IF NOT EXISTS "perks" text[] NOT NULL DEFAULT ARRAY[]::text[];
--> statement-breakpoint
UPDATE "token_subscription_plans"
SET "price_cents" = 499,
    "perks"       = ARRAY[
      'Monthly token reward',
      'Exclusive cosmetics & titles',
      'Enhanced profile customization',
      'Ad-free experience'
    ],
    "updated_at"  = now()
WHERE "key" = 'grynd-plus';
--> statement-breakpoint
