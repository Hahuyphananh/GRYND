-- Migration 0192 — Tic-Tac-Toe Duel match infrastructure.
--
-- Server-authoritative 1v1 turn-based tic-tac-toe: a 3x3 board, nine cells,
-- X vs O, X moves first, three in a row wins, a full board with no line is a
-- draw. NO wagers, NO tokens, NO balances, NO payouts — so unlike the older
-- PvP tables there is deliberately no stake_amount / prize_paid / house_fee
-- column, and no money is ever moved by settlement.
--
-- Matchmaking follows the Mini Golf pattern (0179) rather than Pool Masters'
-- lobby+match pair (0022): a single `tic_tac_toe_matches` row with a nullable
-- `player2_id` and status 'waiting' IS the open lobby, so create-or-join
-- matches two players under one advisory lock with no second table to keep in
-- sync.
--
-- THERE IS NO `seed` COLUMN, ON PURPOSE. Tic-tac-toe contains no randomness:
-- the board is a pure function of the accepted move order, so the match needs
-- no generated seed to reproduce (unlike mini golf's course). The append-only
-- move log alone replays the entire match.
--
-- The authoritative game state is `game_state` (jsonb), produced only by
-- `src/lib/tic-tac-toe/rules.ts`. The scalar columns are denormalised copies
-- of the fields the platform filters/sorts/settles on (turn, ply, status,
-- result) so the lobby list and the canonical queue never parse JSON.
--
-- Player ids are plain clerk-id strings with no FK to `users`, matching every
-- other PvP table.

CREATE TABLE IF NOT EXISTS tic_tac_toe_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id VARCHAR(255) NOT NULL,
  player2_id VARCHAR(255),
  winner_id VARCHAR(255),
  current_turn_user_id VARCHAR(255),
  ply INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'playing', 'finished', 'cancelled')),
  game_state JSONB NOT NULL,
  is_ai BOOLEAN NOT NULL DEFAULT FALSE,
  result VARCHAR(20) CHECK (result IN ('player1', 'player2', 'tie')),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tic_tac_toe_matches_status_idx
  ON tic_tac_toe_matches(status, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tic_tac_toe_matches_player1_idx
  ON tic_tac_toe_matches(player1_id, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tic_tac_toe_matches_player2_idx
  ON tic_tac_toe_matches(player2_id, created_at DESC);--> statement-breakpoint

-- Append-only move log: one row per accepted mark, holding only the validated
-- inputs. The mark itself is NOT stored: it is a pure function of the ply
-- (`ply % 2 === 0` is X), so storing it would be redundant state that could
-- drift out of agreement with the ply counter.
CREATE TABLE IF NOT EXISTS tic_tac_toe_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES tic_tac_toe_matches(id) ON DELETE CASCADE,
  ply INT NOT NULL,
  player_id VARCHAR(255) NOT NULL,
  cell_index INT NOT NULL CHECK (cell_index BETWEEN 0 AND 8),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS tic_tac_toe_moves_match_idx
  ON tic_tac_toe_moves(match_id, ply);--> statement-breakpoint

-- Anti-replay guarantee: at most one persisted move per turn number per match.
CREATE UNIQUE INDEX IF NOT EXISTS tic_tac_toe_moves_ply_unique
  ON tic_tac_toe_moves(match_id, ply);--> statement-breakpoint

-- THE GAME RULE, AS A STORAGE INVARIANT: a cell can never be occupied twice.
-- The application check exists so a duplicate placement is a clean 409; this
-- index is the structural backstop that makes the illegal state unrepresentable
-- even if a future code path forgets the check.
CREATE UNIQUE INDEX IF NOT EXISTS tic_tac_toe_moves_cell_unique
  ON tic_tac_toe_moves(match_id, cell_index);
