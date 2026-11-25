-- 0260: advertise private custom rooms as a shipped PRO benefit.
--
-- Room creation has been enforced server-side since the room routes landed:
-- `POST /api/rooms` resolves the tier from the subscription row and refuses a
-- free account (`pro_required`), and a room now carries the host's chosen
-- entry stake and open-for timer, both re-validated by the server. So the
-- benefit moves from `planned` to `available` in src/lib/proBenefits.ts and
-- this migration brings the plan row's `perks` array in line with
-- ADVERTISED_PRO_PERKS — item for item, in order. tests/pro-benefits.test.mjs
-- asserts that, so the catalog change and this migration ship together.
--
-- Idempotent: a plain UPDATE keyed on the plan. No price, product, subscription
-- or Stripe binding is touched.
UPDATE "token_subscription_plans"
   SET "perks" = ARRAY[
         'Unlimited game analysis — replay and review every match, every day',
         'Ad-free browsing and gaming',
         'Private custom rooms with custom timers and shareable invite codes',
         'Advanced statistics and performance analytics, including graphs',
         'PRO badge, founder frame and exclusive tables — visible to every player you meet'
       ],
       "updated_at" = now()
 WHERE "key" = 'grynd-pro';
