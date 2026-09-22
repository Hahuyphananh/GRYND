-- Crash Arena — prevent duplicate active seats via partial unique index.
--
-- Closes a race condition where concurrent join requests for the same table
-- could both pass the existing-seat check (lines 148-158 in join/route.ts)
-- and insert duplicate rows, because the (table_id, user_id) index was
-- non-unique. The start-round flow then creates one entry per duplicate
-- player row, and settlement applies each payout to ALL rows matching
-- (table_id, user_id), multiplying the credit.
--
-- This partial unique index enforces that a user may have at most ONE active row per table (seated or waiting). Historical "left" rows are unrestricted, so the constraint does not block re-joining after leaving.
--
-- The join route already checks for existing active seats (lines 148-158),
-- so legitimate requests will continue to receive the "Already seated" error.
-- Concurrent duplicates that slip through the check will now fail at insert
-- time with a unique constraint violation, which the route can handle
-- gracefully (the second request sees "Already seated" or a generic error).
--
-- DEDUPE PRE-STEP (why this migration can run "late")
--   The race this index defends against may ALREADY have produced duplicate
--   active rows in an environment where 0161 has not been applied yet. Postgres
--   refuses to build a unique index over such data, so applying this file to a
--   dirty table fails with:
--
--     ERROR: could not create unique index "crash_arena_players_table_user_active_uniq"
--     DETAIL: Key (table_id, user_id)=(...) is duplicated.
--
--   The block below retires every active seat except the NEWEST one per
--   (table_id, user_id) BEFORE the index is created. The newest row is the one
--   the player actually holds; the older duplicates are marked 'left'. Because
--   the partial index only covers status IN ('seated', 'waiting'), the retired
--   rows neither block its creation nor block re-joining. Rows are kept (not
--   deleted) so the historical audit trail survives.
--
--   Note: this repairs the seat rows so the constraint can be installed. Any
--   duplicate crash_arena_entries rows already written for an in-flight round
--   are a separate data-repair concern (settlement matches entries by entry.id,
--   not by aggregating player rows).

-- ── Dedupe pre-step (idempotent) ──────────────────────────────────────────
-- Rank active seats per (table_id, user_id) with the newest first, then mark
-- every rank > 1 as 'left'. On a clean table nothing matches, so re-running is
-- a no-op.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY table_id, user_id
      ORDER BY joined_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM crash_arena_players
  WHERE status IN ('seated', 'waiting')
)
UPDATE crash_arena_players AS p
   SET status = 'left'
  FROM ranked
 WHERE p.id = ranked.id
   AND ranked.rn > 1;

-- ── Partial unique index ──────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS crash_arena_players_table_user_active_uniq
  ON crash_arena_players (table_id, user_id)
  WHERE status IN ('seated', 'waiting');
