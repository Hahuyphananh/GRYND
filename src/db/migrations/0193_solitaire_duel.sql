-- Migration 0193 — Solitaire Duel match infrastructure.
--
-- Server-authoritative 1v1 simultaneous Klondike race: ONE server-generated
-- deal (`klondike-1`, single-card draw, unlimited redeals) that BOTH seats play
-- from their own independent board. First seat to put all 52 cards on the
-- foundations wins; if the match limit expires first, the greater progress wins.
-- NO wagers, NO tokens, NO balances, NO payouts — so unlike the older PvP
-- tables there is deliberately no stake_amount / prize_paid / house_fee column,
-- and no money is ever moved by settlement.
--
-- Matchmaking follows the Mini Golf / Tic-Tac-Toe pattern rather than Pool
-- Masters' lobby+match pair: a single `solitaire_duel_matches` row with a
-- nullable `player2_id` and status 'waiting' IS the open lobby, so
-- create-or-join matches two players under one advisory lock with no second
-- table to keep in sync.
--
-- THE DEAL LIVES ON THE MATCH ROW, ONCE. `deal` is the single canonical puzzle
-- both seats start from, generated at match creation from `deal_seed` (a
-- SHA-256 digest of `server_seed`, see src/lib/solitaire-duel/seeds.js) and
-- NEVER regenerated when the second player joins. `p1_state` and `p2_state` are
-- the two independent boards, each a pure copy of that deal at ply 0 — both are
-- NOT NULL because a match without two boards has no meaning.
--
-- THE SERVER SEED IS SECRET UNTIL TERMINAL. `server_seed_hash` is the public
-- commitment shown before play; `server_seed` is only ever returned once the
-- match is finished or cancelled, so either player can verify the deal was the
-- committed one after it can no longer help anyone.
--
-- Player ids are plain clerk-id strings with no FK to `users`, matching every
-- other PvP table.

CREATE TABLE IF NOT EXISTS solitaire_duel_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The frozen ruleset. Versioned into the deal digest, so changing the rules
  -- can never silently reinterpret an existing match's stored deal.
  variant VARCHAR(24) NOT NULL DEFAULT 'klondike-1',
  variant_version INT NOT NULL DEFAULT 1,
  player1_id VARCHAR(255) NOT NULL,
  player2_id VARCHAR(255),
  winner_id VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'playing', 'finished', 'cancelled')),
  result VARCHAR(20) CHECK (result IN ('player1', 'player2', 'draw')),
  resolution_reason VARCHAR(20)
    CHECK (resolution_reason IN ('finish', 'deadline', 'forfeit', 'draw')),
  -- Provably-fair seed pair: commitment public pre-match, seed revealed after.
  server_seed VARCHAR(64) NOT NULL,
  server_seed_hash VARCHAR(64) NOT NULL,
  -- uint32 derived from server_seed + match id + variant version.
  deal_seed BIGINT NOT NULL,
  -- The ONE canonical deal, shared by both seats (tableau + stock order).
  deal JSONB NOT NULL,
  -- The two independent authoritative boards, each derived from `deal`.
  p1_state JSONB NOT NULL,
  p2_state JSONB NOT NULL,
  -- Denormalised per-seat facts, so the lobby, the opponent-progress
  -- projection and the settlement never parse JSONB.
  p1_ply INT NOT NULL DEFAULT 0,
  p2_ply INT NOT NULL DEFAULT 0,
  p1_peak_foundation INT NOT NULL DEFAULT 0,
  p2_peak_foundation INT NOT NULL DEFAULT 0,
  p1_revealed INT NOT NULL DEFAULT 0,
  p2_revealed INT NOT NULL DEFAULT 0,
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

CREATE INDEX IF NOT EXISTS solitaire_duel_matches_status_idx
  ON solitaire_duel_matches(status, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS solitaire_duel_matches_player1_idx
  ON solitaire_duel_matches(player1_id, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS solitaire_duel_matches_player2_idx
  ON solitaire_duel_matches(player2_id, created_at DESC);--> statement-breakpoint

-- The deadline sweeper's index: "which live matches are past their limit".
CREATE INDEX IF NOT EXISTS solitaire_duel_matches_due_idx
  ON solitaire_duel_matches(status, deadline_at);--> statement-breakpoint

-- Append-only per-seat move log: the authoritative replay record, holding only
-- the validated input the server accepted.
--
-- `ply_unique` does more than prevent replays: it makes "one accepted move per
-- ply, per seat" a STORAGE invariant, so a duplicated or racing POST can never
-- advance a board twice even if an application check is ever bypassed. Together
-- with the stored deal it reproduces the entire match, and it is the reason no
-- client-submitted score, progress or result is ever needed or trusted.
CREATE TABLE IF NOT EXISTS solitaire_duel_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL
    REFERENCES solitaire_duel_matches(id) ON DELETE CASCADE,
  seat VARCHAR(10) NOT NULL
    CHECK (seat IN ('player1', 'player2')),
  ply INT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  move JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS solitaire_duel_moves_match_idx
  ON solitaire_duel_moves(match_id, seat, ply);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS solitaire_duel_moves_ply_unique
  ON solitaire_duel_moves(match_id, seat, ply);
