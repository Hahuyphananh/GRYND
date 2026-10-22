-- 0227_dominoes.sql
--
-- ONLINE 1v1 DOMINOES — match persistence and the append-only action log.
--
-- WHAT THIS IS: the classic two-player block game on a double-six set, played
-- online for fifteen seconds a turn. The server owns the deal, the chain, both
-- hands, the face-down pile, whose turn it is and the result; the API routes
-- only relay an action ADDRESS plus the version it was shown
-- (src/app/api/dominoes/**, src/lib/dominoes/serverStore.ts).
--
-- ── PUBLIC STATE vs SECRET STATE ────────────────────────────────────────
--
-- `game_state` holds the engine's PUBLIC position (chain, open ends, turn,
-- terminal outcome) — the same shape the table view renders. The three SECRET
-- columns are split out on purpose:
--
--   p1_hand, p2_hand  one seat's tiles each
--   draw_pile         the face-down tiles, in shuffled order (index 0 is next)
--
-- Splitting them means the per-viewer projection cannot leak a hand by
-- forgetting to delete a field from a JSON blob: a projection reads the
-- viewer's own column and nothing else, and the opponent's hand is published
-- only as a COUNT. Reconnect restores the same deal from these columns — no
-- re-shuffle, no re-deal.
--
-- `game_state` is NULL while the row is an open lobby: the deal is minted in
-- the transaction that seats the second player, so a host can never preview a
-- hand and re-open the lobby until it is good (see the schema comment).
--
-- ── NO WAGER COLUMNS ────────────────────────────────────────────────────
--
-- Dominoes is unstaked. There is deliberately no stake_amount / house_fee /
-- prize_paid / payout column, no escrow row and no currency path, so a
-- mis-configured lobby cannot move coins.
--
-- ── CONCURRENCY ─────────────────────────────────────────────────────────
--
-- `ply` is the optimistic-concurrency version (and the turn number). The move
-- log is UNIQUE on (match_id, ply), which makes "one persisted action per turn"
-- a storage invariant: a duplicated or concurrently replayed action loses on
-- this index instead of applying twice. `turn_deadline_at` is
-- `timestamptz` — a fifteen-second window must not depend on the DB session's
-- timezone, unlike the display timestamps on this table.
--
-- Additive and idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS "dominoes_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "player1_id" varchar(255) NOT NULL,
  -- NULL while the row is an open lobby.
  "player2_id" varchar(255),
  -- waiting | playing | finished | cancelled
  "status" varchar(20) NOT NULL DEFAULT 'waiting',
  -- Accepted actions so far: the optimistic-concurrency version.
  "ply" integer NOT NULL DEFAULT 0,
  -- The seat on turn (a Clerk id); NULL while waiting and once terminal.
  "current_turn_user_id" varchar(255),
  -- Absolute instant this turn expires, stamped from the server clock.
  "turn_deadline_at" timestamp with time zone,
  -- PUBLIC engine state only (never a hand, never the pile).
  "game_state" jsonb,
  -- SECRET per-seat hands and the face-down pile, in shuffled order.
  "p1_hand" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "p2_hand" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "draw_pile" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "winner_id" varchar(255),
  -- player1 | player2 | draw
  "result" varchar(20),
  -- emptied-hand | blocked-pips | resigned | abandoned
  "result_reason" varchar(32),
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- The lobby list and the two "my matches" lookups.
CREATE INDEX IF NOT EXISTS "dominoes_matches_status_idx"
  ON "dominoes_matches" ("status", "created_at");
CREATE INDEX IF NOT EXISTS "dominoes_matches_player1_idx"
  ON "dominoes_matches" ("player1_id", "created_at");
CREATE INDEX IF NOT EXISTS "dominoes_matches_player2_idx"
  ON "dominoes_matches" ("player2_id", "created_at");

CREATE TABLE IF NOT EXISTS "dominoes_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "match_id" uuid NOT NULL REFERENCES "dominoes_matches"("id") ON DELETE CASCADE,
  -- The turn number that was OPEN when the action was taken.
  "ply" integer NOT NULL,
  "player_id" varchar(255) NOT NULL,
  -- play | draw | pass
  "action" varchar(12) NOT NULL,
  -- Tile id ("6-3") for a play; NULL for a draw or a pass.
  "tile" varchar(8),
  -- left | right for a play; NULL otherwise.
  "chain_end" varchar(5),
  -- True when the server's turn clock produced this action, not the player.
  "timed_out" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Anti-replay: exactly one persisted action per turn number per match.
CREATE UNIQUE INDEX IF NOT EXISTS "dominoes_moves_ply_unique"
  ON "dominoes_moves" ("match_id", "ply");
-- The history read (and the index the unique constraint covers for lookups).
CREATE INDEX IF NOT EXISTS "dominoes_moves_match_idx"
  ON "dominoes_moves" ("match_id", "ply");
