-- Migration 0210 — Game Evaluation: exactly one row per (user, game, match).
--
-- WHY. `POST /api/evaluation/[gameKey]/[matchId]` is idempotent BY LOOKUP: the
-- service read `evaluation_results` for the caller's key, and only then ran the
-- Stockfish analysis (~8–20 s of CPU) and the model call, then inserted. Two
-- requests that arrive together both miss that lookup and both do the whole
-- thing. The consequences are not cosmetic:
--
--   * two rows for the same (user, game, match) — the "one evaluation per
--     match" promise the feature is built on;
--   * two Stockfish analyses and two model calls for one match, i.e. the most
--     expensive work in the feature done twice;
--   * and, because the Free allowance is a per-day COUNT, two concurrent
--     requests by a Free caller each see a count of 0 and each insert, spending
--     the one-per-UTC-day allowance twice.
--
-- The unique index below is the database-level arbiter for the first two. It is
-- what `claimEvaluation()` (src/lib/evaluation/evaluationService.ts) relies on:
-- the claim INSERTs a `pending` row before any expensive work and lets the
-- conflict decide the winner, instead of reading and hoping. The Free daily
-- limit is additionally serialised per caller with `pg_advisory_xact_lock`
-- inside that same short transaction, because no uniqueness constraint can
-- express "at most one row per user per day" for DIFFERENT matches.
--
-- THE KEY. (user_id, game_key, match_id) — the service's own idempotency key
-- (one row per caller per game per match). `match_id` is polymorphic (chess
-- uses a uuid, other games a serial), which is why the key includes game_key
-- rather than being a bare match id.
--
-- ── IF DUPLICATES ALREADY EXIST ─────────────────────────────────────────
-- A UNIQUE index cannot be created over duplicate keys, and Postgres would
-- reject the statement anyway — but with an error that says nothing about what
-- to do. The DO block below therefore checks FIRST and RAISES, which aborts the
-- migration (drizzle runs each migration in a transaction, so the table and
-- every row are left exactly as they were — NOTHING IS DELETED):
--
--   * the failure is loud and actionable, and re-running after a decision
--     creates the index;
--   * it reports COUNTS ONLY — how many keys are duplicated and how many rows
--     they cover — never a user id, a game key or a match id, so a migration log
--     cannot leak who was affected.
--
-- CLEANUP IS A SEPARATE, REVIEWED DECISION — deliberately not automated here.
-- To inspect the affected keys (read-only; run it yourself before deciding):
--
--   SELECT user_id, game_key, match_id, count(*) AS rows,
--          min(created_at) AS oldest, max(created_at) AS newest
--   FROM evaluation_results
--   GROUP BY user_id, game_key, match_id
--   HAVING count(*) > 1
--   ORDER BY newest DESC;
--
-- The plan we would review: keep the row that is `complete` (a real result the
-- player already saw), otherwise the newest; any other row for the same key is
-- a duplicate whose only remaining value is its `ai_response`, so delete only
-- after checking it is not the only copy of a usable analysis. That is a data
-- change on production rows and must not ride along with a schema migration.
--
-- ROLLBACK. Dropping the index loses no data and is safe:
--   DROP INDEX IF EXISTS "evaluation_results_user_game_match_idx";
-- (The application keeps working; it degrades to the pre-0210 behaviour of
-- duplicate rows under concurrency, which is why the service treats the index
-- as required and pairs its claim with ON CONFLICT.)
--
-- Idempotent: IF NOT EXISTS everywhere, so it is safe to re-run.

DO $$
DECLARE
  duplicated_keys integer;
  duplicated_rows integer;
BEGIN
  -- 0181 created the table; if it is absent this migration is out of order and
  -- saying so is far more useful than "relation does not exist".
  IF to_regclass('evaluation_results') IS NULL THEN
    RAISE EXCEPTION
      'evaluation_results does not exist — apply 0181_evaluation_results before 0210';
  END IF;

  SELECT count(*), coalesce(sum(rows_per_key), 0)
    INTO duplicated_keys, duplicated_rows
  FROM (
    SELECT count(*) AS rows_per_key
    FROM evaluation_results
    GROUP BY user_id, game_key, match_id
    HAVING count(*) > 1
  ) AS duplicated;

  IF duplicated_keys > 0 THEN
    RAISE EXCEPTION
      'evaluation_results holds % duplicate (user_id, game_key, match_id) key(s) across % row(s). '
      'No unique index was created and NO row was deleted. Review those keys (see the query in '
      'this migration''s header), decide which row to keep per key, then re-run this migration.',
      duplicated_keys, duplicated_rows
      USING ERRCODE = 'unique_violation';
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_results_user_game_match_idx"
  ON "evaluation_results" ("user_id", "game_key", "match_id");
