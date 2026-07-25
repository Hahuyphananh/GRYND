BEGIN;

-- 1. Create the missing `hex_duel_actions` table.
--
-- The Drizzle schema (`src/db/schema.ts`, line ~1037) declares this table
-- and every multiplayer API route inserts/selects from it, but the only
-- existing hex migration (`0024_hex_duel_games.sql`) only creates
-- `hex_duel_games`. Result: every multiplayer POST that tries to write
-- an action row (`/api/hex-duel/multiplayer/action`, the realtime-server
-- `hexDuel:action` relay has no DB write but the client-driven fallback
-- POST does), and every GET that reads them (`/multiplayer/actions`,
-- `/multiplayer/spectate`) returns 500 with `relation
-- "hex_duel_actions" does not exist`.
--
-- Columns mirror `src/db/schema.ts → hexDuelActions` and are pre-sized
-- to `varchar(50)` so future action types (anything new like
-- `reinforce`, `fortify`, `pass`, or future feature flags) fit without
-- another migration. `varchar(20)` would have rejected a 21-char
-- action_type once any new feature was added; `varchar(50)` is the
-- wider cap chosen up front.
CREATE TABLE IF NOT EXISTS hex_duel_actions (
  id SERIAL PRIMARY KEY,
  game_id integer NOT NULL REFERENCES hex_duel_games(id) ON DELETE CASCADE,
  user_id varchar(255) NOT NULL,
  action_type varchar(50) NOT NULL,
  source_key varchar(50),
  target_key varchar(50),
  troop_count integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Mirror the index declared in `schema.ts → hexDuelActions.gameSeqIdx`
-- so the `/api/hex-duel/multiplayer/actions?afterId=...` polling query
-- is an index seek on (game_id, id) rather than a sequential scan.
CREATE INDEX IF NOT EXISTS hex_duel_actions_game_seq_idx
  ON hex_duel_actions(game_id, id);

CREATE INDEX IF NOT EXISTS hex_duel_actions_user_id_idx
  ON hex_duel_actions(user_id);

-- 2. Add server-authoritative columns to `hex_duel_games`.
--
-- `current_turn` (nullable): the player whose turn it is RIGHT NOW as
-- decided by the server. The legacy `status` string ('turn_player1' /
-- 'turn_player2' / 'in_progress') is kept for backwards compatibility
-- with the existing lobby + spectate route filters, but the truth of
-- "who plays next" comes from this column from now on.
--
-- `last_action_seq` (nullable): the highest `hex_duel_actions.id` that
-- has been incorporated into the server's authoritative state. Lets
-- the client cheaply detect "I have missed N opponent actions" without
-- a COUNT(*) query, and lets both clients converge after a disconnect
-- by replaying all actions with id > last_action_seq.
--
-- Both are nullable so existing completed/historical rows (created
-- before this migration) stay valid. New rows are written with
-- non-null values by the multiplayer routes.
ALTER TABLE hex_duel_games
  ADD COLUMN IF NOT EXISTS current_turn varchar(10);

ALTER TABLE hex_duel_games
  ADD COLUMN IF NOT EXISTS last_action_seq integer;

-- 3. Backfill `current_turn = 'player1'` for in-progress games that
--    exist at migration time and never had a column to read from.
--
-- `player1` is the conventional opening player (matches the frontend
-- page.tsx behavior at line ~2091 "sync-request (turn-start safety net)"
-- and the existing `/multiplayer/status` GET that defaults
-- `in_progress → currentTurn=player1`). This makes a game that was
-- created before this migration and is stuck in `in_progress` playable
-- again as soon as both players reconnect.
UPDATE hex_duel_games
SET current_turn = 'player1'
WHERE status IN ('in_progress', 'turn_player1', 'turn_player2')
  AND player2_id IS NOT NULL
  AND current_turn IS NULL;

-- 4. Backfill `last_action_seq` to the highest existing action id per
--    game so the polling endpoint doesn't re-deliver every pre-migration
--    action on the first post-migration poll (the client tracks its own
--    `afterId` so dup delivery isn't catastrophic, but this keeps things
--    tidy).
UPDATE hex_duel_games g
SET last_action_seq = COALESCE((
  SELECT MAX(a.id) FROM hex_duel_actions a WHERE a.game_id = g.id
), 0)
WHERE last_action_seq IS NULL;

COMMIT;
