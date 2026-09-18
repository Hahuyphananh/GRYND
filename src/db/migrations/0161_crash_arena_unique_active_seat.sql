-- Crash Arena — prevent duplicate active seats via partial unique index.
--
-- Closes a race condition where concurrent join requests for the same table
-- could both pass the existing-seat check (lines 148-158 in join/route.ts)
-- and insert duplicate rows, because the (table_id, user_id) index was
-- non-unique. The start-round flow then creates one entry per duplicate
-- player row, and settlement applies each payout to ALL rows matching
-- (table_id, user_id), multiplying the credit.
--
-- This partial unique index enforces that a user may have at most ONE active
-- (seated or waiting) row per table. Historical "left" rows are unrestricted,
-- so the constraint does not block re-joining after leaving.
--
-- The join route already checks for existing active seats (lines 148-158),
-- so legitimate requests will continue to receive the "Already seated" error.
-- Concurrent duplicates that slip through the check will now fail at insert
-- time with a unique constraint violation, which the route can handle
-- gracefully (the second request sees "Already seated" or a generic error).

CREATE UNIQUE INDEX IF NOT EXISTS crash_arena_players_table_user_active_uniq
  ON crash_arena_players (table_id, user_id)
  WHERE status IN ('seated', 'waiting');
