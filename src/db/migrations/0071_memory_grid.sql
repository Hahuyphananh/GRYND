-- ── Memory Grid PvP match system ──────────────────────────────────
-- Two-player real-time "Memory Grid", best-of-5 rounds — pure
-- pattern recall (no symbols/questions). Each round deals an N×N
-- grid (3×3, 4×4, 4×4, 5×5, 5×5) with a fixed number of active
-- (lit) tiles (3, 5, 7, 10, 14) and a memorize window (2.5–4s).
-- Every round has exactly two phases, played by BOTH players
-- SIMULTANEOUSLY (a competitive race — no turns) on the SAME
-- server-generated pattern:
--   PHASE 1 — MEMORIZE: active tiles revealed to BOTH players at the
--   same time for the round's memorize duration.
--   PHASE 2 — RECONSTRUCT: pattern hides; each player taps the tiles
--   they remember on their own blank grid and submits as soon as
--   they finish (the submitter then waits, grid frozen, for the
--   opponent). Once BOTH players have submitted (or been AFK
--   auto-locked), the round resolves.
-- After the round is resolved (higher round score wins it), the next
-- round opens; after 5 rounds the player with the higher TOTAL
-- cumulative round score takes the pot (exactly equal totals →
-- DRAW, full refund — the existing PvP tie pattern).
--
-- Schema conventions match mines_pvp_matches / mines_pvp_rounds:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * stake/financials as numeric(10, 2)
--   * pgEnum for `status` keeps the 5 match states strongly typed
--   * `memory_grid_rounds` cascades from `memory_grid_matches`
--
-- Flow: waiting → ready → active (memorize → reconstruct, per round
--       1..5) → finished
--       (waiting/ready/active → cancelled)
--
-- Synchronized-commit pattern mirrors plinko-pvp: per-seat
-- p1_submitted/p2_submitted flags; the round resolves once both are
-- true (plinko's p1_ready/p2_ready).
--
-- Payout (mirrors Mines Duel):
--   Winner: own stake back + 90% of loser's stake (1.9× total)
--   Loser:  loses entire stake
--   House:  10% rake on loser's stake only
--   Draw:   both refunded, no rake

-- ── enum ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_grid_status') THEN
    CREATE TYPE memory_grid_status AS ENUM (
      'waiting',
      'ready',
      'active',
      'finished',
      'cancelled'
    );
  END IF;
END
$$;
--> statement-breakpoint

-- ── matches ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "memory_grid_matches" (
  "id" serial PRIMARY KEY,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "stake_amount" numeric(10, 2) NOT NULL,
  "status" memory_grid_status NOT NULL DEFAULT 'waiting',
  -- The current round's pattern — SERVER-ONLY state. Shape:
  --   { "size": 4, "total": 16, "active": [0, 5, 12, ...] }
  -- where `active` holds the round's activeCount distinct row-major
  -- tile indices (the lit tiles). /status reveals `active` to BOTH
  -- players simultaneously during the round's memorize phase, and
  -- to both clients once the match finishes.
  "board" jsonb NOT NULL DEFAULT '{"size":3,"total":9,"active":[]}'::jsonb,
  -- Which phase of the current round is live: 'memorize' |
  -- 'reconstruct' | NULL (null outside active play). Combined with
  -- `status` ('active') it fully describes the game.
  "phase" varchar(20),
  -- Provably-fair seeds (mirrors lane_rush_duel_matches): a shared
  -- SERVER seed (32 random hex bytes, crypto-generated at creation)
  -- + its committed SHA-256 hash. Every round's pattern derives
  -- deterministically from a SHA-256 digest of
  --   serverSeed:matchId:round:roundNumber
  -- (see src/lib/memory-grid/seeds.js), so BOTH players get the
  -- exact same grid per round and every pattern is verifiable
  -- post-match. Hash exposed pre-match; raw seed revealed post-match.
  "server_seed" varchar(128) NOT NULL,
  "server_seed_hash" varchar(64) NOT NULL,
  -- Whether each seat has submitted (or been AFK auto-locked) for
  -- the CURRENT round. Mirrors plinko-pvp's p1_ready/p2_ready
  -- synchronized-commit pattern: the round resolves once both are
  -- true. Reset to false each round.
  "p1_submitted" boolean NOT NULL DEFAULT false,
  "p2_submitted" boolean NOT NULL DEFAULT false,
  -- Reconstruction scores for the CURRENT round (correct active
  -- tiles picked by each player; null until that player submits).
  -- The round winner is decided by comparing these two.
  "p1_round_score" integer NOT NULL DEFAULT 0,
  "p2_round_score" integer NOT NULL DEFAULT 0,
  -- Rounds WON across the match (best-of-5) — display tally +
  -- tiebreak indicator. The MATCH winner is decided on TOTAL
  -- cumulative round scores (p1_total/p2_total); equal totals →
  -- draw refund.
  "p1_score" integer NOT NULL DEFAULT 0,
  "p2_score" integer NOT NULL DEFAULT 0,
  -- Current round number (1..5). Starts at 1 when player2 joins;
  -- incremented by the server when a round completes.
  "round_number" integer NOT NULL DEFAULT 1,
  -- Chronologically-ordered JSONB array of the CURRENT round's
  -- reconstruction submissions (one per player):
  --   { kind: "reconstruct", userId, seat, picks: [tileIdx, ...],
  --     score: int, autoLocked: bool, submittedAt }
  -- Completed rounds are snapshotted into memory_grid_rounds.
  "flips" jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Phase deadline (absolute). 'memorize' → moment the pattern
  -- hides; 'reconstruct' → moment BOTH players' selections lock
  -- (15s shared window). When it elapses and a player hasn't
  -- submitted, the server auto-locks that seat with score 0 via
  -- fetchMatchWithAutoResolve.
  "round_deadline" timestamp,
  "round_timer_seconds" integer NOT NULL DEFAULT 15,
  -- Final match bookkeeping.
  "winner_id" varchar(255),
  "result" varchar(20), -- 'player1' | 'player2' | 'draw' | null
  "house_fee" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memory_grid_status_idx"
  ON "memory_grid_matches" ("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memory_grid_player1_idx"
  ON "memory_grid_matches" ("player1_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memory_grid_player2_idx"
  ON "memory_grid_matches" ("player2_id", "created_at");
--> statement-breakpoint

-- Stake matchmaking — finding a waiting lobby whose stake matches
-- the joiner's request.
CREATE INDEX IF NOT EXISTS "memory_grid_stake_open_idx"
  ON "memory_grid_matches" ("stake_amount", "status");
--> statement-breakpoint

-- ── rounds (per-round snapshots) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "memory_grid_rounds" (
  "id" serial PRIMARY KEY,
  "match_id" integer NOT NULL REFERENCES "memory_grid_matches"("id") ON DELETE CASCADE,
  "round_number" integer NOT NULL DEFAULT 1,
  -- The round's pattern (grid size + active tile indices)
  -- snapshotted at completion so post-match replays can render the
  -- full layout.
  "board_snapshot" jsonb NOT NULL DEFAULT '{"size":3,"total":9,"active":[]}'::jsonb,
  -- Full chronological reconstruction-submission list of the round
  -- (one entry per player), mirrored at completion for replay views.
  "flips" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "p1_round_score" integer NOT NULL DEFAULT 0,
  "p2_round_score" integer NOT NULL DEFAULT 0,
  -- 'player1' | 'player2' | 'draw' | null
  "round_winner" varchar(10),
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memory_grid_rounds_match_round_idx"
  ON "memory_grid_rounds" ("match_id", "round_number");

