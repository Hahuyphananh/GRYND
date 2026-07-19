-- Migration 0053 — Plinko Duel PvP schema safety net
--
-- WHY THIS EXISTS:
--   Migration 0052 ("plinko_pvp_ready_and_collision.sql") adds the
--   p1_ready / p2_ready boolean columns that the launchBall()
--   server-side commit requires. An earlier version of 0052 was
--   rejected on Neon because it also tried to create a partial
--   index on a non-existent column ("match_id" — the real PK is
--   "id", and child rows live on plinko_pvp_rounds). 0052 was then
--   rewritten WITHOUT the bad index, but if the rewrite was never
--   re-applied to the live DB the plinko_pvp_matches table is
--   missing p1_ready / p2_ready, and the POST
--   /api/plinko-pvp/match/[matchId]/launch route 500s the moment
--   either player tries to click "I'm Ready" (the UPDATE references
--   a column that does not exist in Postgres).
--
--   This migration is a SAFETY NET:
--     * It uses `ADD COLUMN IF NOT EXISTS` for EVERY column that the
--       launch path writes or reads, so it can be re-run alongside
--       or in place of 0052 without losing data.
--     * It does NOT depend on drizzle's __drizzle_migrations journal
--       state — even if 0052 is recorded as "failed" in that table,
--       running this migration will still succeed and bring the
--       schema up to date.
--     * The final DO/EXCEPTION block aborts the migration with a
--       clear error if the columns are still missing after the
--       ADD COLUMN runs (defensive — would fire only if someone ran
--       this on a non-Postgres DB).
--
-- HOW TO VERIFY ON NEON (paste into the Neon SQL console):
--
--   -- 1. Confirm the columns exist
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM   information_schema.columns
--   WHERE  table_name = 'plinko_pvp_matches'
--   ORDER  BY ordinal_position;
--
--   -- 2. Inspect the drizzle migration journal
--   SELECT id, hash, created_at
--   FROM   drizzle.__drizzle_migrations
--   ORDER  BY id DESC
--   LIMIT  10;
--
--   -- 3. Confirm rounds table is intact
--   SELECT column_name, data_type
--   FROM   information_schema.columns
--   WHERE  table_name = 'plinko_pvp_rounds'
--   ORDER  BY ordinal_position;
--
-- HOW TO APPLY (idempotent — safe to run multiple times):
--   npm run db:migrate
--   …or, if the drizzle journal refuses to advance past 0052, run
--   this file directly against the Prod branch in the Neon SQL
--   console; every statement is `IF NOT EXISTS` so duplicates are
--   harmless.

--> statement-breakpoint

-- Per-seat "Ready" booleans — required by src/lib/plinko-pvp/serverStore.js
-- (launchBall(), forceBallAdvance()). Default FALSE so existing rows are
-- valid without backfill.
ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_ready" boolean NOT NULL DEFAULT false;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_ready" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Defensive backfills for the rest of the columns the launch path
-- touches. These were created in 0048, but listing them here means
-- this migration can stand alone if 0048 ever gets reverted / lost.
ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "current_ball" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_current_inputs" jsonb;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_current_inputs" jsonb;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "round_deadline" timestamp;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "round_timer_seconds" integer DEFAULT 20 NOT NULL;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "winner_id" varchar(255);--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "result" varchar(20);--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "house_fee" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "prize_paid" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "started_at" timestamp;--> statement-breakpoint

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "ended_at" timestamp;--> statement-breakpoint

-- Final sanity probe — surfaces a Postgres NOTICE with the column
-- presence state on every run. If either ready column is missing
-- AFTER the ADD COLUMN statements run (which would only happen on
-- a non-Postgres DB), the anonymous block raises an explicit error
-- so the migration file doesn't silently succeed.
DO $$
DECLARE
  has_p1_ready boolean;
  has_p2_ready boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plinko_pvp_matches' AND column_name = 'p1_ready'
  ) INTO has_p1_ready;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'plinko_pvp_matches' AND column_name = 'p2_ready'
  ) INTO has_p2_ready;

  IF NOT has_p1_ready OR NOT has_p2_ready THEN
    RAISE EXCEPTION
      '[0053] plinko_pvp_matches is still missing p1_ready/p2_ready after IF NOT EXISTS backfill. '
      'This usually means you are not running on Postgres — verify the DB driver.';
  END IF;

  RAISE NOTICE '[0053] plinko_pvp_matches schema verified: p1_ready=% p2_ready=%',
    has_p1_ready, has_p2_ready;
END;
$$;
