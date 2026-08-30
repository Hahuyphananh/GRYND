-- 0119: Bind the Grynd+ plan to the real Stripe recurring price.
--
-- The subscription product created in the Stripe Dashboard is now attached to
-- the `grynd-plus` plan. The product id is left NULL on purpose —
-- src/lib/stripe/subscriptions.ts resolves it from the price at runtime
-- (ensureSubscriptionPlanStripe), so we never create a duplicate product.
-- `price_cents` / `monthly_tokens` on the row remain fallback values: the
-- displayed price is resolved live from the Stripe price, and `monthly_tokens`
-- is the monthly token grant (update it to the real amount before selling).
-- Idempotent: safe to run repeatedly.

UPDATE "token_subscription_plans"
SET "stripe_price_id" = 'price_1U9xctFCdrsRZ4P9DzwilMiM',
    "updated_at"      = now()
WHERE "key" = 'grynd-plus';
--> statement-breakpoint
