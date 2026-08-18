-- ── Memory Grid cumulative round-score columns ─────────────────────
-- The compact in-match scoreboard shows each player's CUMULATIVE
-- points across the match (each round scores /100, so a 5-round
-- match totals up to 500 — e.g. YOU 247 vs OPPONENT 231), matching
-- the points-based scoreboards of the other skill PvP games
-- (lane-rush-duel, keno-pvp). Previously only rounds-won
-- (p1_score/p2_score) was tracked; the running point totals are
-- accumulated server-side in completeRound alongside the round
-- award and persisted here.

ALTER TABLE "memory_grid_matches"
  ADD COLUMN IF NOT EXISTS "p1_total" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "memory_grid_matches"
  ADD COLUMN IF NOT EXISTS "p2_total" integer NOT NULL DEFAULT 0;
