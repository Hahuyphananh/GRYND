-- Migration 0256 — The recorded ghost pool, and the recording's own pace.
--
-- GHOST RUNS ARE MATERIALIZED. Migration 0255 let a waiting lobby replay a
-- finished match's log directly from `solitaire_duel_matches` /
-- `solitaire_duel_moves`. That works, but it means the pool is only as warm as
-- the source rows are: the retention sweep deletes terminal matches older than
-- 45 days, a re-dealt seat is unusable, and every matchmaking read has to
-- re-verify a candidate's log. This table is the durable pool those reads draw
-- from instead:
--
--   * ONE ROW PER (finished match, replayable seat). The recorded timeline, its
--     deal and the anonymised handle are COPIED here, so a run survives its
--     source match being deleted and never needs a join to be offered.
--   * NO FOREIGN KEY on purpose — the point is to outlive the source row.
--   * `source_clerk_id` exists ONLY so the pool can exclude a player from
--     racing their own recording. It is never exposed to a client; the handle
--     the player sees is `ghost_name` (a one-way digest).
--   * `rating` / `trophies` are the source player's ladder snapshot, so a ghost
--     settles against the strength the opponent actually had.
--   * `trail` is the recording's foundation progress at its own recorded
--     instants — count-only checkpoints, no card identity — so the opponent
--     panel can show the run unfolding at the pace it really happened.
--
-- The backfill job (/api/jobs/solitaire-ghost-pool) fills this table from
-- existing finished ranked matches, which is what makes the pool warm from the
-- first tick rather than after the next human duel finishes.

CREATE TABLE IF NOT EXISTS solitaire_ghost_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_match_id UUID NOT NULL,
  source_seat VARCHAR(10) NOT NULL
    CHECK (source_seat IN ('player1', 'player2')),
  -- Exclusion key only: the pool never races a player against themselves.
  source_clerk_id VARCHAR(255) NOT NULL,
  variant VARCHAR(24) NOT NULL,
  variant_version INT NOT NULL,
  -- The source match's commitment, reused verbatim so the replay's puzzle is
  -- the one that was committed. Still hidden until a ghost match is terminal.
  server_seed VARCHAR(64) NOT NULL,
  server_seed_hash VARCHAR(64) NOT NULL,
  deal_seed BIGINT NOT NULL,
  deal JSONB NOT NULL,
  -- [{ offsetMs, kind, move }] in ply order, offsets from the source GO.
  timeline JSONB NOT NULL,
  -- [{ atMs, foundationCards }] sampled from the verified replay.
  trail JSONB NOT NULL,
  ply INT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_offset_ms INT,
  rating INT,
  trophies INT,
  ghost_name VARCHAR(40) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);--> statement-breakpoint

-- One run per seat per source match: the backfill is idempotent by construction.
CREATE UNIQUE INDEX IF NOT EXISTS solitaire_ghost_runs_source_unique
  ON solitaire_ghost_runs(source_match_id, source_seat);--> statement-breakpoint

-- The pool read: current-variant runs, newest first (and random selection).
CREATE INDEX IF NOT EXISTS solitaire_ghost_runs_pool_idx
  ON solitaire_ghost_runs(variant_version, created_at DESC);--> statement-breakpoint

-- The "never race yourself" exclusion.
CREATE INDEX IF NOT EXISTS solitaire_ghost_runs_clerk_idx
  ON solitaire_ghost_runs(source_clerk_id);--> statement-breakpoint

-- The recording's pace travels with the ghost MATCH too, so the opponent panel
-- can render it without touching the pool row (or re-verifying anything).
ALTER TABLE solitaire_duel_matches
  ADD COLUMN IF NOT EXISTS ghost_trail JSONB;
