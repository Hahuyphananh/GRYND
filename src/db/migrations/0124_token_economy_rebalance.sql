-- 0124: Token economy rebalance — one consistent price per token.
--
-- Grynd+ membership: 5,000 tokens/month for $4.99 (~1,002 tokens/$).
-- One-time packs are rebalanced to the SAME ~1,000 tokens/$ rate (prices
-- unchanged, token amounts raised) so a token has one price everywhere:
--   * a subscriber's monthly grant is exactly the pack-equivalent value of
--     the membership price (no more 25x token-printing),
--   * one-time packs stop being objectively terrible value, so instant
--     buyers and subscribers pay the same per token.
-- `token_amount` stays the base award and `bonus_tokens` the on-top bonus;
-- the customer receives base + bonus (the Shop shows both).
--
-- NOTE: the `own` package (Grynd Tokens 1,000, one-time) is bound to a real
-- Stripe product with an unknown stored price — it was NOT rebalanced. If it
-- sells for $4.99 it should be ~5,000 tokens to stay consistent; update
-- `token_amount` once its Stripe price is known.
-- Idempotent: safe to run repeatedly.

UPDATE "token_subscription_plans"
SET "monthly_tokens" = 5000,
    "updated_at"     = now()
WHERE "key" = 'grynd-plus';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 5000,  "bonus_tokens" = 0,     "updated_at" = now()
WHERE "key" = 'starter';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 10000, "bonus_tokens" = 0,     "updated_at" = now()
WHERE "key" = 'small';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 18000, "bonus_tokens" = 2000,  "updated_at" = now()
WHERE "key" = 'medium';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 36000, "bonus_tokens" = 4000,  "updated_at" = now()
WHERE "key" = 'large';
--> statement-breakpoint
UPDATE "token_packages"
SET "token_amount" = 80000, "bonus_tokens" = 10000, "updated_at" = now()
WHERE "key" = 'mega';
--> statement-breakpoint
