-- 0215: Correct the GRYND PRO perk copy to the approved offer.
--
-- WHY
-- ---
-- The `grynd-pro` row carried perk lines that do not describe the membership:
--
--   * 'Custom chat color & profile accent' — GRYND does not sell profile
--     customization as a membership benefit (and the profile screen prompts for
--     it against a live gate; that reconciliation is separate work).
--   * 'Priority support' — there is no priority support service to provide.
--   * 'Detailed match history' — no detailed match-history feature exists. The
--     existing match history stays free for everyone and is untouched.
--
-- The same six lines were also duplicated in the upgrade page's fixed benefit
-- list, the fallback perk constants and the Stripe product description. Those
-- live in code now and derive from ONE approved catalog (src/lib/proBenefits.ts);
-- this migration brings the DATABASE row — which is the `perks` array served to
-- clients by /api/membership/status — into line with it.
--
-- WHAT IT SAYS
-- ------------
-- Only the benefits that are actually enforced today, matching
-- ADVERTISED_PRO_PERKS in src/lib/proBenefits.ts exactly (a test asserts the two
-- cannot drift). The approved-but-unbuilt benefits (statistics/analytics graphs,
-- extended leaderboards with progression graphs, private custom rooms) are
-- deliberately ABSENT: a row is an advertisement, and the API would otherwise
-- list features the membership does not grant yet. They are recorded in the
-- catalog and added here by the change that ships each one.
--
-- Idempotent: a plain UPDATE keyed on the plan, safe to run repeatedly. No
-- price, product, subscription or Stripe binding is touched.
UPDATE "token_subscription_plans"
   SET "perks" = ARRAY[
         'Ad-free browsing and gaming',
         'Priority matchmaking — a fair queue tie-break, never a skill advantage'
       ],
       "updated_at" = now()
 WHERE "key" = 'grynd-pro';
