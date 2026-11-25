-- 0244_solitaire_solo_daily.sql
--
-- SOLO SOLITAIRE + DAILY CHALLENGE — two new, additive result tables.
--
-- WHY NEW TABLES (and not columns on solitaire_duel_matches)
--   Solo and Daily are single-player modes. A shared table would let a solo row
--   be read by the ranked-history queries and by settlement tooling, which is
--   exactly the contamination the product forbids. Keeping them separate makes
--   "solo never affects Elo / ranked history" a structural property.
--
--   * solitaire_solo_results  — one row per finished solo attempt;
--   * solitaire_daily_results — at most ONE official row per player per UTC
--                               date, enforced by a unique index, so a refresh
--                               or a duplicated POST cannot reroll/inflate the
--                               daily count or streak.
--
-- The server replays the submitted move log against the reconstructed deal
-- before writing either row, so `completed` is verified, never a client claim.
--
-- RLS: default-deny, same pattern as 0243. Every read/write goes through the
-- Next.js server (table owner, bypasses RLS); nothing here is needed by the
-- browser or published to Realtime. Deliberately NOT FORCE RLS.
--
-- Idempotent + additive: CREATE TABLE/INDEX IF NOT EXISTS, no drops, no
-- rewrites, no changes to existing tables or rows.

CREATE TABLE IF NOT EXISTS "solitaire_solo_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar(255) NOT NULL,
  "seed" varchar(20) NOT NULL,
  "completed" boolean NOT NULL DEFAULT false,
  "moves" integer NOT NULL DEFAULT 0,
  "elapsed_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "solitaire_solo_results_user_idx"
  ON "solitaire_solo_results" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "solitaire_daily_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar(255) NOT NULL,
  "challenge_date" varchar(10) NOT NULL,
  "completed" boolean NOT NULL DEFAULT true,
  "moves" integer NOT NULL DEFAULT 0,
  "elapsed_ms" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_daily_results_user_date_unique"
  ON "solitaire_daily_results" ("user_id", "challenge_date");

CREATE INDEX IF NOT EXISTS "solitaire_daily_results_date_idx"
  ON "solitaire_daily_results" ("challenge_date");

ALTER TABLE "solitaire_solo_results" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "solitaire_solo_results_no_client_access" ON "solitaire_solo_results";
CREATE POLICY "solitaire_solo_results_no_client_access" ON "solitaire_solo_results"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

ALTER TABLE "solitaire_daily_results" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "solitaire_daily_results_no_client_access" ON "solitaire_daily_results";
CREATE POLICY "solitaire_daily_results_no_client_access" ON "solitaire_daily_results"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);
