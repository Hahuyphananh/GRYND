-- 0125: `own` package — one-time Grynd Tokens offer now 5,000 tokens.
--
-- Migration 0117 seeded the `own` offer ("Grynd Tokens", bound to the Stripe
-- product) at 1,000 tokens. With the token economy rebalanced to ~1,000
-- tokens per dollar (migration 0124) and the Stripe-bound price at $4.99,
-- the offer must award 5,000 tokens to stay consistent. This bakes the
-- manually-applied value into the migration chain so fresh environments get
-- it too. Idempotent: safe to run repeatedly.

UPDATE "token_packages"
SET "token_amount" = 5000,
    "updated_at"   = now()
WHERE "key" = 'own';
--> statement-breakpoint
