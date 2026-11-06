-- 0240_guest_practice_results.sql
--
-- GUEST PROGRESSION — one row per settled practice match played by a guest.
--
-- ── IDEMPOTENCY IS THE CONSTRAINT, NOT A CONVENTION ──────────────────────
--
-- (game_key, match_id) is UNIQUE. Settlement runs inside the match store's
-- row-locked transaction and uses ON CONFLICT DO NOTHING, so a retried or
-- duplicated completion writes exactly one row. There is no counter column to
-- double-increment either: the progress endpoint derives win/loss/draw counts
-- with COUNT(*) over these rows.
--
-- ── WHY THIS IS A SEPARATE TABLE ─────────────────────────────────────────
--
-- The authoritative match tables already hold the result, but the retention
-- job (src/app/api/jobs/retention/route.ts) DELETEs terminal matches older than
-- 45 days for most of them — tic_tac_toe_matches included. A guest's practice
-- history must survive that sweep, so it is recorded here rather than read back
-- out of a table that is designed to be pruned.
--
-- ── WHAT IT MUST NEVER DO ────────────────────────────────────────────────
--
-- `game_key` uses the canonical RATED_GAMES vocabulary only ("tic-tac-toe"
-- today), but nothing in rating/trophy/stat/token/leaderboard code reads this
-- table. Official Elo and trophies remain keyed by an INTEGER users.id
-- (player_ratings, player_trophies) and a guest has no such row, so a practice
-- result cannot leak into a ranked ladder.
--
-- MATCH_ID: varchar(64). Tic-Tac-Toe's id is a uuid (36 chars, enforced by
-- isMatchId in src/lib/tic-tac-toe/serverStore.ts), and 64 leaves headroom for
-- the text/serial ids other games use when a later phase adds them.

CREATE TABLE IF NOT EXISTS "guest_practice_results" (
  "id" serial PRIMARY KEY,
  "guest_id" varchar(64) NOT NULL
    REFERENCES "guest_profiles" ("guest_id") ON DELETE CASCADE,
  "game_key" varchar(32) NOT NULL,
  "match_id" varchar(64) NOT NULL,
  "result" varchar(8) NOT NULL,
  "ai_difficulty" varchar(16),
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "guest_practice_results_game_match_unique"
    UNIQUE ("game_key", "match_id"),
  CONSTRAINT "guest_practice_results_result_valid"
    CHECK ("result" IN ('win', 'loss', 'draw'))
);

-- The endpoint's only read pattern: one guest's rows, newest first.
CREATE INDEX IF NOT EXISTS "guest_practice_results_guest_idx"
  ON "guest_practice_results" ("guest_id", "created_at" DESC);

COMMENT ON TABLE "guest_practice_results" IS
  'One row per settled guest practice match; unique per (game_key, match_id) so a retried settlement cannot duplicate it';
COMMENT ON COLUMN "guest_practice_results"."game_key" IS
  'Canonical game key (RATED_GAMES vocabulary), e.g. tic-tac-toe';
COMMENT ON COLUMN "guest_practice_results"."match_id" IS
  'The match own id as text (uuid today); never exposed by the progress endpoint';
