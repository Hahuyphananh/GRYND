-- 0150: Memory Grid — decimal round scores.
--
-- The scoring design changed: a round's FINAL score is the exact
-- full-grid accuracy percentage rounded to 1dp (computeFinalRoundScore
-- in src/lib/memory-grid/constants.js — e.g. 81.3, 87.5), NOT an
-- integer. The columns below were still INTEGER, so every submission
-- with a fractional accuracy threw
--   invalid input syntax for type integer: "81.3"  (22P02)
-- at applySubmission → the /reconstruct endpoint 500'd.
--
-- Widen to NUMERIC(…,1). Existing integer values convert cleanly.
-- All code paths read these through Number(...) coercion, so numeric
-- strings returned by the driver are already handled.
--
-- Idempotent: safe to run repeatedly.

ALTER TABLE "memory_grid_matches"
  ALTER COLUMN "p1_round_score" TYPE NUMERIC(6, 1),
  ALTER COLUMN "p2_round_score" TYPE NUMERIC(6, 1),
  ALTER COLUMN "p1_round_score" SET DEFAULT 0.0,
  ALTER COLUMN "p2_round_score" SET DEFAULT 0.0,
  ALTER COLUMN "p1_total" TYPE NUMERIC(7, 1),
  ALTER COLUMN "p2_total" TYPE NUMERIC(7, 1),
  ALTER COLUMN "p1_total" SET DEFAULT 0.0,
  ALTER COLUMN "p2_total" SET DEFAULT 0.0;

ALTER TABLE "memory_grid_rounds"
  ALTER COLUMN "p1_round_score" TYPE NUMERIC(6, 1),
  ALTER COLUMN "p2_round_score" TYPE NUMERIC(6, 1),
  ALTER COLUMN "p1_round_score" SET DEFAULT 0.0,
  ALTER COLUMN "p2_round_score" SET DEFAULT 0.0;
