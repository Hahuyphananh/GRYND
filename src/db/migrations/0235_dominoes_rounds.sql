-- 0235_dominoes_rounds.sql
--
-- MULTI-ROUND DOMINOES — cumulative match scores and an append-only round log.
--
-- WHAT CHANGES. A `dominoes_matches` row used to BE one round: the first hand to
-- empty (or the blocked position) terminalised it. A match is now a series of
-- rounds played to MATCH_TARGET_POINTS (50) cumulative points, and the row
-- carries the scoreboard, while each completed round is appended to
-- `dominoes_rounds`. The FIRST side to reach 50 wins the match.
--
-- ── WHY THE SCORE LIVES ON THE MATCH ROW ────────────────────────────────
--
-- The cumulative totals are the match's own state, read on every projection,
-- so they are columns (not derived from the log on each read). They are only
-- ever advanced by the same ply-conditional UPDATE that applies the action
-- which ended the round — see src/lib/dominoes/serverStore.ts — so a retried
-- request cannot add a round's points twice, and a concurrent submission loses
-- on `ply` before it reaches the score.
--
-- ── WHY ROUNDS GET THEIR OWN TABLE ──────────────────────────────────────
--
-- `game_state` holds ONE position: the round in progress. A completed round's
-- pips, points, winner and ending reason must survive the next deal, so they
-- are rows — one per round, never overwritten. `dominoes_rounds` is
-- append-only and UNIQUE on (match_id, round_number), which is what makes the
-- insert idempotent (ON CONFLICT DO NOTHING) and duplicate round records
-- unrepresentable.
--
-- A round row is public information: pips remaining at the end of a round were
-- already published when the round closed. NO HAND EVER LIVES HERE — the
-- secret columns stay on the match row (p1_hand / p2_hand / draw_pile) and are
-- still split out so a projection cannot leak them.
--
-- ── CONCURRENCY ─────────────────────────────────────────────────────────
--
-- `ply` stays the single optimistic-concurrency version for the WHOLE match and
-- is NEVER reset between rounds: a fresh round's state is rebased onto the
-- ply the previous round ended at, so the move log's unique (match_id, ply)
-- keeps making a replayed action a clean conflict rather than a second move.
--
-- Additive and idempotent: safe to re-run.

-- ── The scoreboard and the round cursor ────────────────────────────────
ALTER TABLE "dominoes_matches"
  ADD COLUMN IF NOT EXISTS "player1_score" integer NOT NULL DEFAULT 0;

ALTER TABLE "dominoes_matches"
  ADD COLUMN IF NOT EXISTS "player2_score" integer NOT NULL DEFAULT 0;

-- The round in progress (1-based). Advanced in the same write that records the
-- round that just ended.
ALTER TABLE "dominoes_matches"
  ADD COLUMN IF NOT EXISTS "round_number" integer NOT NULL DEFAULT 1;

-- The seat that won the round just completed (NULL = a level round), and the
-- seat the CURRENT round's deal chose to start. Both are public; they are the
-- "previous round winner / starting player" the result screen reads.
ALTER TABLE "dominoes_matches"
  ADD COLUMN IF NOT EXISTS "previous_round_winner" varchar(20);

ALTER TABLE "dominoes_matches"
  ADD COLUMN IF NOT EXISTS "previous_starting_seat" varchar(20);

-- ── One row per completed round, append-only ───────────────────────────
CREATE TABLE IF NOT EXISTS "dominoes_rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "match_id" uuid NOT NULL REFERENCES "dominoes_matches"("id") ON DELETE CASCADE,
  -- 1-based, contiguous per match; the cursor the match row also carries.
  "round_number" integer NOT NULL,
  -- Pips each seat still held when the round closed.
  "player1_pips" integer NOT NULL,
  "player2_pips" integer NOT NULL,
  -- Points awarded THIS round (each seat scores the other's remaining pips).
  "player1_points" integer NOT NULL,
  "player2_points" integer NOT NULL,
  -- player1 | player2 (seat), NULL when the round scored level.
  "winner_seat" varchar(20),
  -- emptied-hand | blocked-pips (END_REASONS in src/lib/dominoes/constants.ts).
  "end_reason" varchar(32) NOT NULL,
  -- Absolute instant the round closed, from the SERVER clock.
  "completed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- Duplicate round records are unrepresentable, which is what lets the store's
-- insert be an idempotent ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS "dominoes_rounds_match_round_unique"
  ON "dominoes_rounds" ("match_id", "round_number");

-- The history read (round order within a match).
CREATE INDEX IF NOT EXISTS "dominoes_rounds_match_idx"
  ON "dominoes_rounds" ("match_id", "round_number");

-- ── Backfill: historical single-round matches ──────────────────────────
-- Matches that finished before rounds existed carry their one round's points
-- inside `game_state.outcome.points`. Copy them (SET, never ADD) so an old
-- result reads the same score it always did. Guarded on both scores still being
-- 0, so re-running this file cannot double-count.
UPDATE "dominoes_matches"
SET
  "player1_score" = COALESCE(("game_state" -> 'outcome' -> 'points' ->> 'player1')::integer, 0),
  "player2_score" = COALESCE(("game_state" -> 'outcome' -> 'points' ->> 'player2')::integer, 0)
WHERE "status" = 'finished'
  AND "player1_score" = 0
  AND "player2_score" = 0
  AND "game_state" IS NOT NULL
  AND "game_state" ? 'outcome';
