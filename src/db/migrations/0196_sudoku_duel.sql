-- Migration 0196 — Sudoku Duel match infrastructure.
--
-- Server-authoritative 1v1 simultaneous Sudoku race: ONE server-generated puzzle
-- (`classic-9`) that BOTH seats solve from their own independent board. The first
-- seat to fill its board correctly wins, decided on ADJUSTED completion time
-- (actual completion + a +1s penalty per mistake); if the 10-minute limit
-- expires first, the ladder is most correct cells → fewest mistakes → earliest
-- achievement of that progress. NO wagers, NO tokens, NO balances, NO payouts —
-- so there is deliberately no stake_amount / prize_paid / house_fee column, and
-- no money is ever moved by settlement.
--
-- Matchmaking follows the Mini Golf / Tic-Tac-Toe / Solitaire Duel pattern: a
-- single `sudoku_duel_matches` row with a nullable `player2_id` and status
-- 'waiting' IS the open lobby, so create-or-join matches two players under one
-- advisory lock with no second table to keep in sync.
--
-- THE PUZZLE LIVES ON THE MATCH ROW, ONCE. `puzzle` is the clue grid both seats
-- see; `solution` is the authoritative completion and is SERVER-ONLY. Both are
-- derived deterministically from `puzzle_seed` (a SHA-256 digest of
-- `server_seed`, see src/lib/sudoku-duel/seeds.js) and NEVER regenerated when the
-- second player joins. `p1_state` and `p2_state` are the two independent boards,
-- each a copy of the clue grid at ply 0 — both are NOT NULL because a match
-- without two boards has no meaning.
--
-- A SEAT STATE HOLDS GIVENS + CORRECTLY PLACED VALUES ONLY. An incorrect value
-- is never written: it is counted as a mistake and otherwise discarded. That is
-- what makes "correctly completed cells" a direct read of the board rather than
-- a recomputation, and what keeps the +1s penalty honest.
--
-- THE SERVER SEED IS SECRET UNTIL TERMINAL. `server_seed_hash` is the public
-- commitment shown before play; `server_seed` is only ever returned once the
-- match is finished or cancelled, so either player can verify the puzzle was the
-- committed one after it can no longer help anyone.
--
-- Player ids are plain clerk-id strings with no FK to `users`, matching every
-- other PvP table.

CREATE TABLE IF NOT EXISTS sudoku_duel_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The frozen ruleset. Versioned into the puzzle digest, so changing the rules
  -- can never silently reinterpret an existing match's stored puzzle.
  variant VARCHAR(24) NOT NULL DEFAULT 'classic-9',
  variant_version INT NOT NULL DEFAULT 1,
  -- easy | normal | hard — a clue-count TARGET, not a promise.
  difficulty VARCHAR(16) NOT NULL DEFAULT 'normal'
    CHECK (difficulty IN ('easy', 'normal', 'hard')),
  player1_id VARCHAR(255) NOT NULL,
  player2_id VARCHAR(255),
  winner_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'playing', 'finished', 'cancelled')),
  is_ai BOOLEAN NOT NULL DEFAULT false,
  result VARCHAR(20) CHECK (result IN ('player1', 'player2', 'draw')),
  resolution_reason VARCHAR(20)
    CHECK (resolution_reason IN ('finish', 'deadline', 'forfeit', 'draw')),
  -- Provably-fair seed pair: commitment public pre-match, seed revealed after.
  server_seed VARCHAR(64) NOT NULL,
  server_seed_hash VARCHAR(64) NOT NULL,
  -- uint32 derived from server_seed + variant version. BIGINT (not INT) because
  -- the unsigned value exceeds int4's positive range.
  puzzle_seed BIGINT NOT NULL,
  -- The ONE canonical puzzle: clues (public) and answer (server-only).
  puzzle JSONB NOT NULL,
  solution JSONB NOT NULL,
  givens INT NOT NULL DEFAULT 0,
  -- The two independent authoritative boards, each derived from the clue grid.
  p1_state JSONB NOT NULL,
  p2_state JSONB NOT NULL,
  -- Denormalised per-seat facts, so the lobby, the opponent-progress projection
  -- and the settlement never parse JSONB.
  p1_ply INT NOT NULL DEFAULT 0,
  p2_ply INT NOT NULL DEFAULT 0,
  -- Correctly completed NON-given cells — the competitive metric.
  p1_correct INT NOT NULL DEFAULT 0,
  p2_correct INT NOT NULL DEFAULT 0,
  p1_mistakes INT NOT NULL DEFAULT 0,
  p2_mistakes INT NOT NULL DEFAULT 0,
  p1_penalty_ms INT NOT NULL DEFAULT 0,
  p2_penalty_ms INT NOT NULL DEFAULT 0,
  p1_finished_at TIMESTAMP,
  p2_finished_at TIMESTAMP,
  -- Absolute server instants. Never stored as a per-client delay.
  go_at TIMESTAMP,
  deadline_at TIMESTAMP,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sudoku_duel_matches_status_idx
  ON sudoku_duel_matches(status, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sudoku_duel_matches_player1_idx
  ON sudoku_duel_matches(player1_id, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sudoku_duel_matches_player2_idx
  ON sudoku_duel_matches(player2_id, created_at DESC);--> statement-breakpoint

-- The deadline sweeper's index: "which live matches are past their limit".
CREATE INDEX IF NOT EXISTS sudoku_duel_matches_due_idx
  ON sudoku_duel_matches(status, deadline_at);--> statement-breakpoint

-- Append-only per-seat action log: the authoritative replay record, holding only
-- the validated input the server judged.
--
-- `ply_unique` makes "one accepted action per ply, per seat" a STORAGE
-- invariant, so a duplicated or racing POST can never advance a board twice even
-- if an application check is ever bypassed. Together with the stored puzzle it
-- reproduces the entire match, and it is the reason no client-submitted score,
-- progress, mistake count or result is ever needed or trusted.
--
-- A logged 'place' is not necessarily correct: an incorrect value is recorded as
-- the action that produced a mistake, while the resulting state still holds only
-- correct entries.
CREATE TABLE IF NOT EXISTS sudoku_duel_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL
    REFERENCES sudoku_duel_matches(id) ON DELETE CASCADE,
  seat VARCHAR(10) NOT NULL
    CHECK (seat IN ('player1', 'player2')),
  ply INT NOT NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('place', 'clear')),
  action JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sudoku_duel_moves_match_idx
  ON sudoku_duel_moves(match_id, seat, ply);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS sudoku_duel_moves_ply_unique
  ON sudoku_duel_moves(match_id, seat, ply);
