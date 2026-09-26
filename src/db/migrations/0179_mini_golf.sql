-- Migration 0179 — Mini Golf PvP match infrastructure.
--
-- Server-authoritative 1v1 turn-based mini golf: best-of-5 holes, first to
-- win 3 holes wins the match. NO wagers, NO tokens, NO payouts — so unlike
-- every other PvP table there is deliberately no stake_amount / prize_paid /
-- house_fee column, and no money is ever moved by settlement.
--
-- Matchmaking follows the Plinko Duel pattern (0048) rather than Pool
-- Masters' lobby+match pair (0022): a single `mini_golf_matches` row with a
-- nullable `player2_id` and status 'waiting' IS the open lobby, so
-- create-or-join matches two players under one advisory lock with no second
-- table to keep in sync.
--
-- The authoritative game state is `game_state` (jsonb), produced only by
-- `src/lib/mini-golf/rules.ts`. The scalar columns are denormalised copies
-- of the fields the platform filters/sorts/settles on so the lobby list and
-- the canonical queue never parse JSON. `seed` is the source of truth for
-- the course; `game_state.holes` is the frozen snapshot generated from it.
--
-- Player ids are plain clerk-id strings with no FK to `users`, matching
-- every other PvP table.

CREATE TABLE IF NOT EXISTS mini_golf_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player1_id VARCHAR(255) NOT NULL,
  player2_id VARCHAR(255),
  winner_id VARCHAR(255),
  current_turn_user_id VARCHAR(255),
  current_hole INT NOT NULL DEFAULT 1,
  player1_hole_wins INT NOT NULL DEFAULT 0,
  player2_hole_wins INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'ready', 'playing', 'finished', 'cancelled')),
  -- 32-bit unsigned seed range exceeds int4, so bigint.
  seed BIGINT NOT NULL,
  course_version INT NOT NULL,
  game_state JSONB NOT NULL,
  is_ai BOOLEAN NOT NULL DEFAULT FALSE,
  result VARCHAR(20) CHECK (result IN ('player1', 'player2', 'tie')),
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mini_golf_matches_status_idx
  ON mini_golf_matches(status, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mini_golf_matches_player1_idx
  ON mini_golf_matches(player1_id, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mini_golf_matches_player2_idx
  ON mini_golf_matches(player2_id, created_at DESC);--> statement-breakpoint

-- Append-only shot log: one row per accepted stroke, holding the exact
-- validated inputs and the deterministic simulation output.
CREATE TABLE IF NOT EXISTS mini_golf_shots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID NOT NULL REFERENCES mini_golf_matches(id) ON DELETE CASCADE,
  shot_seq INT NOT NULL,
  hole_number INT NOT NULL,
  player_id VARCHAR(255) NOT NULL,
  stroke_number INT NOT NULL,
  angle NUMERIC NOT NULL,
  power NUMERIC NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mini_golf_shots_match_idx
  ON mini_golf_shots(match_id, created_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mini_golf_shots_hole_idx
  ON mini_golf_shots(match_id, hole_number);--> statement-breakpoint

-- Anti-replay guarantee: at most one persisted shot per sequence per match.
CREATE UNIQUE INDEX IF NOT EXISTS mini_golf_shots_seq_unique
  ON mini_golf_shots(match_id, shot_seq);
