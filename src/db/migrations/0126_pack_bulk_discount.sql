-- 0126: One-time packs — escalating bulk discount (more $ → more tokens/$).
--
-- Migration 0124 set every pack to a flat ~1,000 tokens/$. This migration
-- reintroduces tiered value like a real shop: bigger packs pay a higher
-- rate per dollar. The discount lives in `bonus_tokens` (already displayed
-- by the Shop as "+N bonus"):
--
--   starter: 5,000                (~1,002 tokens/$ — base rate)
--   small:   10,000 + 500  bonus  (~1,051 tokens/$ — +5%)
--   medium:  20,000 + 2,000 bonus (~1,100 tokens/$ — +10%)
--   large:   40,000 + 8,000 bonus (~1,200 tokens/$ — +20%)
--   mega:    90,000 + 30,000 bonus(~1,333 tokens/$ — +33%)
--
-- Prices are unchanged. The `own` offer (5,000 tokens, Stripe-bound price)
-- stays at the base rate. Idempotent: safe to run repeatedly.

UPDATE "token_packages"
SET "token_amount" = 5000,  "bonus_tokens" = 0,     "updated_at" = now()
WHERE "key" = 'starter';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 10000, "bonus_tokens" = 500,   "updated_at" = now()
WHERE "key" = 'small';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 20000, "bonus_tokens" = 2000,  "updated_at" = now()
WHERE "key" = 'medium';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 40000, "bonus_tokens" = 8000,  "updated_at" = now()
WHERE "key" = 'large';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 90000, "bonus_tokens" = 30000, "updated_at" = now()
WHERE "key" = 'mega';
--> statement-breakpoint
