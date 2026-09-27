-- ── Mines PvP — shared-board preparation ────────────────────────────
-- Additive, non-destructive columns for the shared-board competitive
-- Minesweeper rules. Nothing here changes existing behaviour on its
-- own: the flag flow and the win-reason stamping land in later steps.
-- Every statement uses ADD COLUMN IF NOT EXISTS, so this migration is
-- safe to re-run and safe on a database that already has the columns
-- (matches the 0084/0050 Mines PvP migration convention).
--
-- WHY each column:
--   * `p1_flags` / `p2_flags` — under the shared-board rules a FLAG is a
--     per-player CLAIM, not a pick: each seat owns its own set, the same
--     cell may be claimed by both, a flag never ends the match on its
--     own, and a wrong flag is not a loss. Flags therefore cannot live
--     inside the `picks` turn history (which counts turns); they get
--     their own columns. Each value is a JSONB array of unique, sorted
--     0-24 row-major cell indices (canonical order — `normalizeFlags`).
--   * `win_reason` — WHY the match ended, so the client/result screen
--     can distinguish a mine hit from an all-mines-flagged win (and the
--     infrastructure endings). The shared-board rules added the second
--     player-driven ending, so `result` alone is no longer enough.

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p1_flags" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "p2_flags" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "win_reason" varchar(32);
--> statement-breakpoint

-- Replay mirror: the rounds snapshot is the post-match read path, so it
-- carries the same ending label without joining the live match row.
ALTER TABLE "mines_pvp_rounds"
  ADD COLUMN IF NOT EXISTS "win_reason" varchar(32);
