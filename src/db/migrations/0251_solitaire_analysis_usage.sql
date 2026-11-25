-- 0251_solitaire_analysis_usage.sql
--
-- GRYND PRO — the free-plan Game Review allowance, counted server-side.
--
-- WHY
--   Game Review used to be unlimited for everyone: a review of a game the cache
--   had not seen yet runs a full deep-search analysis, which is the most
--   expensive thing the solitaire stack does. The plan now sells UNLIMITED
--   analysis (PRO) against 3 fresh analyses per day on the free plan, so the
--   count has to live where the browser cannot reach it.
--
-- WHAT IS COUNTED
--   One row per (player, UTC day). `used` is incremented ONLY for an analysis
--   the cache could not serve — re-opening a game that is already analysed is
--   free and never touches this table. `/api/solitaire/review` and
--   `/api/solitaire-duel/match/[id]/review` both consume through
--   src/lib/solitaire-duel/analysisAllowance.ts.
--
-- WHY A TABLE (not memory)
--   The quota must survive a server restart and be shared by every instance;
--   an in-process counter would reset on deploy and multiply by instance count.
--   There is deliberately NO foreign key to `users`: the same allowance applies
--   to a signed guest (`grynd_guest` cookie), whose identity is not a user row.
--   Account deletion removes the rows for that id in the same sweep as the
--   player's other solitaire data.
--
-- RETENTION
--   Two days of rows are enough to answer "did this identity analyse 3 games
--   today?"; older rows are dropped by the nightly sweep. The primary key is
--   the lookup, so no extra index is needed.
--
-- RLS: default-deny, like `solitaire_analysis_cache`. Only the Next.js server
-- reads or writes this table; nothing is published to the browser or Realtime.
--
-- Idempotent + additive: CREATE TABLE IF NOT EXISTS, no drops, no rewrites.
-- The trailing UPDATE re-publishes the `grynd-pro` perk row so a database that
-- already ran 0215 advertises the same catalog this release ships.

CREATE TABLE IF NOT EXISTS "solitaire_analysis_usage" (
  -- Clerk user id, or the signed guest id. No FK: a guest has no user row.
  "user_id" varchar(255) NOT NULL,
  -- UTC calendar day, YYYY-MM-DD. The allowance resets at UTC midnight.
  "day_key" varchar(10) NOT NULL,
  -- Fresh (uncached) analyses consumed today. Never decremented.
  "used" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "solitaire_analysis_usage_pk" PRIMARY KEY ("user_id", "day_key")
);

ALTER TABLE "solitaire_analysis_usage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "solitaire_analysis_usage_no_client_access" ON "solitaire_analysis_usage";
CREATE POLICY "solitaire_analysis_usage_no_client_access" ON "solitaire_analysis_usage"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE "solitaire_analysis_usage" IS
  'Per-identity, per-UTC-day count of fresh Game Review analyses consumed; PRO members are never counted';
COMMENT ON COLUMN "solitaire_analysis_usage"."day_key" IS
  'UTC calendar day (YYYY-MM-DD) the allowance resets on';
COMMENT ON COLUMN "solitaire_analysis_usage"."used" IS
  'Fresh (cache-miss) analyses consumed that day; a cached re-view costs nothing';

UPDATE "token_subscription_plans"
   SET "perks" = ARRAY[
         'Ad-free browsing and gaming',
         'Unlimited game analysis — replay and review every match, every day',
         'Advanced statistics and performance analytics, including graphs',
         'Priority matchmaking — a fair queue tie-break, never a skill advantage'
       ],
       "updated_at" = now()
 WHERE "key" = 'grynd-pro';
