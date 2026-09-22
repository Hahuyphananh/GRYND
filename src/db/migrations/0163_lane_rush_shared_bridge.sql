-- Lane Rush Duel — SHARED GLASS BRIDGE state (Prompt 1 state layer).
--
-- The redesigned game plays on ONE shared bridge for the whole match:
-- 10 rows, exactly one bad tile per row, alternating turns, memory flags,
-- a 15s per-choice window, and "first to cross row 10 wins" (no points,
-- no banking, no multipliers, no peek).
--
-- This migration is ADDITIVE ONLY:
--   * it adds the bridge + per-seat bridge state the new engine writes;
--   * it does NOT drop the legacy tower/points/banking columns. Rows in
--     history still describe the old game, so those columns are left in
--     place (unused by the new engine) rather than destroyed.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS), so it can also be
-- pasted straight into the Supabase SQL editor.

ALTER TABLE "lane_rush_duel_matches"
  ADD COLUMN IF NOT EXISTS "bridge" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "p1_row" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "p2_row" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "broken" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "p1_flags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "p2_flags" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- `bridge` holds the SERVER-SIDE layout:
--   { rows, tiles, difficulty, badTiles: [...], commitment }
-- (see buildSharedBridge in src/lib/lane-rush-duel/constants.js).
-- It is never sent to a client as-is: the API routes hand out
-- bridgeClientView(bridge, { broken }) + the public flag list only.

COMMENT ON COLUMN "lane_rush_duel_matches"."bridge" IS
  'Lane Rush shared bridge layout (server-only: rows/tiles/difficulty/badTiles/commitment)';

COMMENT ON COLUMN "lane_rush_duel_matches"."p1_row" IS
  'Rows crossed by player 1 on the shared bridge (0..10; 10 = crossed, wins)';

COMMENT ON COLUMN "lane_rush_duel_matches"."p2_row" IS
  'Rows crossed by player 2 on the shared bridge (0..10; 10 = crossed, wins)';

COMMENT ON COLUMN "lane_rush_duel_matches"."broken" IS
  'Bad tiles already stepped on: [{row,tile}, ...] — broken for the rest of the match';

COMMENT ON COLUMN "lane_rush_duel_matches"."p1_flags" IS
  'Player 1 memory flags: [{row,tile}, ...] (visible to both players)';

COMMENT ON COLUMN "lane_rush_duel_matches"."p2_flags" IS
  'Player 2 memory flags: [{row,tile}, ...] (visible to both players)';

-- Per-tile choice window is 15s in the redesigned game (was 20s per turn).
ALTER TABLE "lane_rush_duel_matches"
  ALTER COLUMN "round_timer_seconds" SET DEFAULT 15;

UPDATE "lane_rush_duel_matches"
   SET "round_timer_seconds" = 15
 WHERE "round_timer_seconds" <> 15
   AND "status" NOT IN ('finished', 'cancelled');

-- Row-level security is unchanged: the table was already locked down by
-- earlier migrations (only the app's owner connection reads/writes it).
