-- 0258: put the new visible PRO benefit on the offer row.
--
-- The `perks` array on the plan row is what /api/membership/status serves and
-- what the Stripe product copy is built from. It must equal
-- ADVERTISED_PRO_PERKS in src/lib/proBenefits.ts item for item and in order —
-- tests/pro-benefits.test.mjs asserts that, so this migration and the catalog
-- change ship together.
--
-- The new line is the visible-identity benefit: a PRO badge on every leaderboard
-- and in chat, plus the PRO-only profile frames and table themes. It is
-- advertised only because the server enforces it: the badge comes from the
-- subscription row (src/lib/proStatus.ts), and a PRO-only cosmetic is refused
-- for a non-member by src/lib/cosmetics.ts.
--
-- Idempotent: a plain UPDATE keyed on the plan. No price, product, subscription
-- or Stripe binding is touched.
UPDATE "token_subscription_plans"
   SET "perks" = ARRAY[
         'Ad-free browsing and gaming',
         'PRO badge, founder frame and exclusive tables — visible to every player you meet',
         'Unlimited game analysis — replay and review every match, every day',
         'Advanced statistics and performance analytics, including graphs',
         'Priority matchmaking — a fair queue tie-break, never a skill advantage'
       ],
       "updated_at" = now()
 WHERE "key" = 'grynd-pro';
