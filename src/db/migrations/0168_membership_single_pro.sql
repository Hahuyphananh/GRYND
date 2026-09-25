-- 0168: Collapse membership to a single GRYND PRO subscription.
--
-- GRYND now has exactly two membership states: free and pro. The former
-- Grynd+ and High Roller tiers are deprecated:
--
--   * `grynd-pro` becomes the ONE purchasable plan — renamed GRYND PRO, with
--     months of token grants removed (monthly_tokens = 0) and its perk copy
--     replaced by the non-competitive PRO feature list (ad-free, advanced
--     statistics / performance analytics, detailed match history, profile
--     customization, priority support).
--   * `grynd-plus` and `grynd-high-roller` are DISABLED for new checkouts.
--     Their rows (and their Stripe product/price bindings) are preserved, not
--     deleted, so existing subscribers and billing history stay intact.
--
-- Existing paid subscriptions are NOT downgraded: the server resolves ANY
-- active subscription to the `pro` state (see getMembershipTier in
-- src/lib/stripe/subscriptions.ts), so a legacy Grynd+ / High Roller member
-- keeps full GRYND PRO access until they cancel.
--
-- Token grants are gone entirely — the Stripe webhook no longer credits
-- balances on paid invoices (and never credited anything for a $0 trial
-- invoice). `monthly_tokens = 0` is a belt-and-braces guard so no leftover
-- code path can credit the old amount.
--
-- Idempotent: safe to run repeatedly.

-- 1) The single GRYND PRO plan. Price is unchanged ($9.99/mo); no tokens.
UPDATE "token_subscription_plans"
   SET "name" = 'GRYND PRO',
       "monthly_tokens" = 0,
       "badge" = 'Pro',
       "enabled" = true,
       "featured" = true,
       "sort_order" = 1,
       "perks" = ARRAY[
         'Ad-free experience',
         'Advanced performance analytics',
         'Advanced statistics',
         'Detailed match history',
         'Custom chat color & profile accent',
         'Priority support'
       ],
       "updated_at" = now()
 WHERE "key" = 'grynd-pro';
--> statement-breakpoint

-- 2) Deprecated tiers — no longer purchasable. Rows kept for existing
--    subscribers and Stripe/grant history; monthly_tokens zeroed so nothing
--    can mint tokens from a legacy plan either.
UPDATE "token_subscription_plans"
   SET "enabled" = false,
       "featured" = false,
       "monthly_tokens" = 0,
       "updated_at" = now()
 WHERE "key" IN ('grynd-plus', 'grynd-high-roller');
--> statement-breakpoint

-- 3) If the plan row did not exist (fresh install), create the single plan so
--    the checkout route has something to sell.
INSERT INTO "token_subscription_plans"
  ("key", "name", "monthly_tokens", "price_cents", "badge", "enabled", "featured", "sort_order", "perks")
VALUES
  ('grynd-pro', 'GRYND PRO', 0, 999, 'Pro', true, true, 1, ARRAY[
    'Ad-free experience',
    'Advanced performance analytics',
    'Advanced statistics',
    'Detailed match history',
    'Custom chat color & profile accent',
    'Priority support'
  ])
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
