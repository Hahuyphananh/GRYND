-- ── Mega Tic-Tac-Toe — a move addresses a BOARD as well as a cell ───────────
--
-- The game grew from one 3x3 board into a lattice of up to nine 3x3 boards
-- (see src/lib/tic-tac-toe/rules.ts). The append-only move log must therefore
-- record WHICH board each accepted mark landed on, not only the cell.
--
-- Additive and idempotent: the new column defaults to 0, so every legacy row
-- (and every legacy match, which only ever had one board) reads back as board
-- 0 with no data migration. No existing column is dropped and no existing data
-- is rewritten.
--
-- The occupancy invariant is widened in place: the original unique index on
-- (match_id, cell_index) would forbid two different boards from both using
-- cell 0, so it is dropped and recreated on (match_id, board_index,
-- cell_index) under the SAME name, keeping the structural backstop that a
-- (board, cell) pair can never be occupied twice. It is safe to drop and
-- recreate inside one migration because the default of 0 makes the existing
-- rows already satisfy the new key.

ALTER TABLE "tic_tac_toe_moves"
  ADD COLUMN IF NOT EXISTS "board_index" INT NOT NULL DEFAULT 0;--> statement-breakpoint

-- A lattice slot is 0..8; -1 is the sentinel for the sudden-death board that
-- only exists after the stage-3 tiebreaker is itself tied.
ALTER TABLE "tic_tac_toe_moves"
  DROP CONSTRAINT IF EXISTS tic_tac_toe_moves_board_index_check;--> statement-breakpoint
ALTER TABLE "tic_tac_toe_moves"
  ADD CONSTRAINT tic_tac_toe_moves_board_index_check
  CHECK (board_index BETWEEN -1 AND 8);--> statement-breakpoint

DROP INDEX IF EXISTS tic_tac_toe_moves_cell_unique;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS tic_tac_toe_moves_cell_unique
  ON tic_tac_toe_moves(match_id, board_index, cell_index);
