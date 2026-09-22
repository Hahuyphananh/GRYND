-- Keno PvP — 1v1 SURVIVAL DUEL state.
--
-- The game no longer plays "first to 10 points in a 16-round match". It is
-- now a single continuous survival run on the shared 1..40 board:
--
--   * both players start with 3 lives;
--   * ONE tile is lit at a time and both players race for it;
--   * the first tap claims the tile and costs the opponent a life;
--   * a tile nobody claims in time is a BOTH-MISS — both lose a life;
--   * the window starts at 1.6s and tightens 100ms per claimed tile, down
--     to a 0.4s floor;
--   * lives at 0 = eliminated (opponent takes the pot). Both eliminated on
--     the same both-miss = draw (full refund). Board exhausted with both
--     alive = more lives wins, equal = draw.
--
-- This migration is ADDITIVE ONLY:
--   * it adds the lives / live-tile / tile-log columns the new engine
--     writes;
--   * it does NOT drop the legacy per-round columns (current_draw,
--     p1_catches, scores, rounds_won_*, current_round). Rows in history
--     still describe the old game, so those columns are left in place
--     (unused by the new engine) rather than destroyed;
--   * it does NOT touch the keno_pvp_status pgEnum. The live run reuses
--     the existing "round_1" value for its whole duration (ALTER TYPE
--     … ADD VALUE is not safe inside the migration path), so no row ever
--     has to move to a new enum value.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS), so it can also be
-- pasted straight into the Supabase SQL editor.

ALTER TABLE "keno_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_lives" integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "p2_lives" integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS "p1_tiles" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "p2_tiles" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "live_tile" integer,
  ADD COLUMN IF NOT EXISTS "live_tile_index" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "live_started_at" timestamp,
  ADD COLUMN IF NOT EXISTS "used_tiles" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "tile_log" jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN "keno_pvp_matches"."p1_lives" IS
  'Player 1 survival lives (3 at kick-off; 0 = eliminated)';

COMMENT ON COLUMN "keno_pvp_matches"."p2_lives" IS
  'Player 2 survival lives (3 at kick-off; 0 = eliminated)';

COMMENT ON COLUMN "keno_pvp_matches"."p1_tiles" IS
  'Tiles claimed first by player 1 this match (drives the shrinking window)';

COMMENT ON COLUMN "keno_pvp_matches"."p2_tiles" IS
  'Tiles claimed first by player 2 this match (drives the shrinking window)';

COMMENT ON COLUMN "keno_pvp_matches"."live_tile" IS
  'The tile currently lit for both players (1..40), or NULL when no tile is live';

COMMENT ON COLUMN "keno_pvp_matches"."live_tile_index" IS
  'How many tiles this match has resolved (0-based index of the live tile)';

COMMENT ON COLUMN "keno_pvp_matches"."live_started_at" IS
  'When the live tile lit up (server clock) — reaction times are measured from here';

COMMENT ON COLUMN "keno_pvp_matches"."used_tiles" IS
  'Tiles already drawn this match: [1..40, ...] — a tile never lights twice';

COMMENT ON COLUMN "keno_pvp_matches"."tile_log" IS
  'Public per-tile history: [{tile,index,outcome,at,p1Lives,p2Lives,windowMs,reactionMs}, ...]';

-- `round_deadline` is now the live tile's expiry (`live_started_at` + the
-- current window), and `round_timer_seconds` records the opening window in
-- seconds. Documented so the legacy name is not mistaken for round state.
COMMENT ON COLUMN "keno_pvp_matches"."round_deadline" IS
  'Deadline of the CURRENT live tile (live_started_at + the window). NULL when no tile is live';

COMMENT ON COLUMN "keno_pvp_matches"."round_timer_seconds" IS
  'Opening claim window in seconds (legacy column name; the window shrinks each claim)';

ALTER TABLE "keno_pvp_matches"
  ALTER COLUMN "round_timer_seconds" SET DEFAULT 2;

-- Existing IN-FLIGHT rows belong to the retired multi-round game: no client
-- can drive them any more, so they would sit escrowed forever. Settle each
-- one as a DRAW and REFUND both escrowed stakes (no rake) — the same outcome
-- the old server-store draw path produced. Terminal/historical rows are left
-- completely untouched.
--
-- `status = 'ready'` and the legacy round_* / overtime states are the only
-- ones that can still be mid-match; `waiting` lobbies stay open (they are
-- already compatible — a joiner just starts a survival run), and
-- finished/cancelled rows are history.
CREATE TEMP TABLE keno_survival_refunds AS
SELECT id, player1_id, player2_id, stake_amount
  FROM "keno_pvp_matches"
 WHERE "status" IN (
   'ready',
   'round_2', 'round_3', 'round_4', 'round_5', 'round_6', 'round_7', 'round_8',
   'round_9', 'round_10', 'round_11', 'round_12', 'round_13', 'round_14',
   'round_15', 'round_16', 'overtime'
 );

UPDATE "users" u
   SET "balance" = u."balance" + r."stake_amount"
  FROM keno_survival_refunds r
 WHERE u."clerk_id" = r."player1_id"
    OR u."clerk_id" = r."player2_id";

UPDATE "keno_pvp_matches" m
   SET "status" = 'finished',
       "result" = 'draw',
       "winner_id" = NULL,
       "house_fee" = '0.00',
       "prize_paid" = '0.00',
       "round_deadline" = NULL,
       "current_draw" = NULL,
       "p1_catches" = NULL,
       "p2_catches" = NULL,
       "ended_at" = COALESCE(m."ended_at", NOW())
  FROM keno_survival_refunds r
 WHERE m."id" = r."id";

DROP TABLE keno_survival_refunds;

-- Row-level security is unchanged: the table was already locked down by
-- earlier migrations (only the app's owner connection reads/writes it).
