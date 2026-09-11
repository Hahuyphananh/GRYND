-- 0155: Grynd membership tiers — Grynd Pro + Grynd High Roller.
--
-- Adds two higher tiers above the base Grynd+ plan, each with a better
-- tokens-per-dollar rate while staying at-or-below the one-time Mega pack
-- rate (1,333 tokens/$):
--
--   * grynd-pro          $9.99  (999¢) → 12,000 tokens/mo (~1,201/$)
--   * grynd-high-roller  $19.99 (1999¢) → 26,000 tokens/mo (~1,301/$)
--
-- `perks` is the sales copy the Shop renders on the membership cards; each
-- advertised perk is implemented behind the active-subscription / tier check:
--   * monthly streak-shield grants + 3× XP boost: webhook
--     (grantSubscriptionInvoiceTokens, keyed on plan_key),
--   * login-reward multiplier + chat badge/title: plan_key-based tier
--     resolution (getMembershipTier in src/lib/stripe/subscriptions.ts).
-- `featured` marks one card as "Best Value" in the Shop (the one-time packs
-- use the same flag); it is cosmetic only.
-- Idempotent: safe to run repeatedly.

INSERT INTO "token_subscription_plans"
  ("key", "name", "monthly_tokens", "price_cents", "badge", "enabled", "featured", "sort_order", "perks")
VALUES
  ('grynd-pro', 'Grynd Pro', 12000, 999, 'Pro', true, false, 2, ARRAY[
    '12,000 tokens / month',
    '3x Daily Streak Shield / month',
    '1x 3x XP Boost (48h) / month',
    'GRYND PRO chat badge & title',
    'Enhanced profile customization',
    'Priority matchmaking',
    'Ad-free experience'
  ]),
  ('grynd-high-roller', 'Grynd High Roller', 26000, 1999, 'High Roller', true, true, 3, ARRAY[
    '26,000 tokens / month',
    '5x Daily Streak Shield / month',
    '2x 3x XP Boost (48h) / month',
    'HIGH ROLLER chat badge & title',
    '+100% login reward (vs +50% base)',
    'Enhanced profile customization',
    'Priority matchmaking',
    'Ad-free experience'
  ])
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint