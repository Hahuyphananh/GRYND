-- 0261: refresh the GRYND PRO value box.
--
-- The offer now leads with replays/analysis, adds the PRO daily archive,
-- promotes the visible membership (badge + founder flair) and closes with ad
-- removal. Private custom rooms are still enforced by POST /api/rooms, but they
-- are no longer part of the value box, so the served plan row drops them.
--
-- This migration brings `perks` in line with ADVERTISED_PRO_PERKS — item for
-- item, in order. tests/pro-benefits.test.mjs asserts that the catalog and the
-- served row ship together.
--
-- Idempotent: a plain UPDATE keyed on the plan. No price, product, subscription
-- or Stripe binding is touched.
UPDATE "token_subscription_plans"
   SET "perks" = ARRAY[
         'Unlimited Match Replays & Analysis — Scrub through every move, spot time-loss spikes, and review optimal lines after every game.',
         'Deep Performance Graphs — Track Elo trends, win rates by game mode, and speed benchmarks over time.',
         'Daily Challenge Archive — Replay any past Daily Deal or seed you missed and compare against the global board.',
         'PRO Leaderboard Badge & Founder Flair — Stand out in lobbies and rankings with an exclusive PRO badge and board theme.',
         '100% Ad-Free Experience — Zero banners or interruptions while you play.'
       ],
       "updated_at" = now()
 WHERE "key" = 'grynd-pro';
