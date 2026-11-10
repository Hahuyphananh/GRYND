-- 0248_solitaire_move_history.sql
--
-- GAME REVIEW HISTORY for Solo Solitaire and the Daily Challenge.
--
-- WHAT THIS ADDS
--   * solitaire_solo_results.move_log   — the canonical, server-verified move
--     log of a COMPLETED attempt; NULL for abandoned attempts and legacy rows.
--   * solitaire_solo_results.log_digest — SHA-256 of that ordered log, used as
--     an idempotency key: (user_id, seed, log_digest) is unique, so a retried
--     POST writes nothing while a different attempt still gets its own row.
--   * solitaire_daily_results.move_log / log_digest — the official completed
--     run. The existing (user_id, challenge_date) unique index already makes
--     the day idempotent; the digest is stored for symmetry and diagnostics.
--
-- WHY COLUMNS, NOT A CHILD TABLE
--   A solo/daily result is one finished attempt, and the analysis engine reads
--   the whole ordered log at once. A `solitaire_solo_moves` child table would
--   add a row per ply (100–300 rows per game), a second retention surface and a
--   second insert path, without buying a read the JSONB log cannot serve. The
--   ranked duel keeps its per-move table because move rows are the live
--   concurrency control there (`ply_unique`); nothing here races per ply.
--
-- WHAT IS NOT STORED
--   No board snapshots: the seed (solo) or UTC date (daily) re-derives the deal,
--   and the log replays it through the same engine. A log is only written after
--   `replayMoves` accepts every move and the board is solved, so an incomplete
--   or unverified game can never masquerade as a complete review.
--
-- RETENTION / RLS
--   These tables are not part of the 45-day PvP sweep today, and this migration
--   does not add them to it. New columns inherit the existing default-deny RLS;
--   every read/write still goes through the Next.js server.
--
-- Idempotent + additive: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- no drops, no rewrites, no backfill (legacy rows legitimately have no log).

ALTER TABLE "solitaire_solo_results"
  ADD COLUMN IF NOT EXISTS "move_log" jsonb;

ALTER TABLE "solitaire_solo_results"
  ADD COLUMN IF NOT EXISTS "log_digest" varchar(64);

ALTER TABLE "solitaire_daily_results"
  ADD COLUMN IF NOT EXISTS "move_log" jsonb;

ALTER TABLE "solitaire_daily_results"
  ADD COLUMN IF NOT EXISTS "log_digest" varchar(64);

-- A retried completed submission maps to the SAME (user, seed, log digest) and
-- conflicts. Abandoned attempts have a NULL digest; Postgres treats NULLs as
-- distinct, so their rows keep inserting exactly as before and existing
-- statistics do not change.
CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_solo_results_user_seed_log_unique"
  ON "solitaire_solo_results" ("user_id", "seed", "log_digest");

-- Defence in depth: an abandoned solo attempt can never carry a review log.
DO $$
BEGIN
  ALTER TABLE "solitaire_solo_results"
    ADD CONSTRAINT "solitaire_solo_results_log_requires_completion"
    CHECK ("move_log" IS NULL OR "completed");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN "solitaire_solo_results"."move_log" IS
  'Canonical server-verified log of a completed solo game; NULL for abandoned attempts and legacy rows';
COMMENT ON COLUMN "solitaire_solo_results"."log_digest" IS
  'SHA-256 of move_log; unique with (user_id, seed) so a retried submission is idempotent';
COMMENT ON COLUMN "solitaire_daily_results"."move_log" IS
  'Canonical server-verified log of the one official daily completion; never updated';
COMMENT ON COLUMN "solitaire_daily_results"."log_digest" IS
  'SHA-256 of move_log, stored for audit; idempotency is the (user_id, challenge_date) unique index';
