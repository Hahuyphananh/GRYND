-- 0122: Rebalance the Grynd+ monthly token grant.
--
-- 100,000 tokens/mo for $4.99 was ~20,000 tokens/$ — roughly 100-200x the
-- value of the one-time packs (100-200 tokens/$), which made the packs
-- objectively pointless for subscribers. 25,000 tokens/mo (~5,000 tokens/$,
-- ~25x the Mega pack rate) keeps the membership the clear best value while
-- leaving the one-time packs a sane option for impatient buyers. The daily
-- login reward (~1.64M per perfect 14-day cycle) is the true token faucet —
-- the grant is a visible monthly perk, not the economy.
-- Idempotent: safe to run repeatedly.

UPDATE "token_subscription_plans"
SET "monthly_tokens" = 25000,
    "updated_at"     = now()
WHERE "key" = 'grynd-plus';
--> statement-breakpoint
