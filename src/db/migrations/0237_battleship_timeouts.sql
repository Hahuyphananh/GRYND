-- 0237_battleship_timeouts.sql
--
-- BATTLESHIP — server-authoritative timeout state.
--
-- ── WHY CONSECUTIVE COUNTERS ARE SEPARATE FROM THE TOTALS ────────────────
--
-- `player1_timeouts` / `player2_timeouts` are TOTALS: a lifetime count of
-- automatic attacks for the match, useful for display and for a future rating
-- signal. They must never be reset, or the record would forget that a player
-- timed out five times.
--
-- The forfeit rule is about CONSECUTIVE timeouts ("a valid manual attack resets
-- the counter"), so it needs its own two columns. Keeping them separate is what
-- makes "timed out twice in a row" expressible without losing the totals.
--
-- ── AUTOMATIC ATTACKS ARE RECORDED, NOT DISGUISED ────────────────────────
--
-- An attack the server chose on a player's behalf must be distinguishable from
-- one the player chose, forever. `battleship_attacks.automatic` marks it; a
-- manual lock is `false`. The cell itself is a normal row, so it takes part in
-- every uniqueness rule exactly like a manual shot:
--
--   UNIQUE (match_id, round, seat)        — one lock per seat per round
--   UNIQUE (match_id, seat, coordinate)   — never a repeated coordinate
--
-- The choosing happens in `src/lib/battleship/timeouts.ts` with
-- `crypto.randomInt`, so it is server-side, uniform and reproducible in tests.
--
-- Defaults let this apply to matches already in flight (there are none in
-- production yet, but a migration that only works on an empty table is a
-- migration that has to be re-run).

ALTER TABLE "battleship_matches"
  ADD COLUMN IF NOT EXISTS "player1_consecutive_timeouts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "battleship_matches"
  ADD COLUMN IF NOT EXISTS "player2_consecutive_timeouts" integer DEFAULT 0 NOT NULL;

COMMENT ON COLUMN "battleship_matches"."player1_consecutive_timeouts" IS
  'Consecutive automatic attacks; reset to 0 by any manual attack; 2 forfeits the match';
COMMENT ON COLUMN "battleship_matches"."player2_consecutive_timeouts" IS
  'Consecutive automatic attacks; reset to 0 by any manual attack; 2 forfeits the match';

ALTER TABLE "battleship_attacks"
  ADD COLUMN IF NOT EXISTS "automatic" boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN "battleship_attacks"."automatic" IS
  'true when the server chose this cell on the seat''s behalf after the 15s deadline';
