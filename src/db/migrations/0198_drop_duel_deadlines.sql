-- 0198: Drop the retired Solitaire/Sudoku Duel match deadlines.
--
-- Both duels are untimed: `deadline_at` stopped being written when the
-- inactivity rule replaced the match clock, and the server no longer reads it.
-- The column and its partial index are dead weight, so both are removed here.
-- `resolution_reason` may still hold a historical 'deadline' on rows settled
-- before the match clock was retired, so its CHECK is deliberately left intact.

DROP INDEX IF EXISTS solitaire_duel_matches_due_idx;--> statement-breakpoint
DROP INDEX IF EXISTS sudoku_duel_matches_due_idx;--> statement-breakpoint
ALTER TABLE solitaire_duel_matches DROP COLUMN IF EXISTS deadline_at;--> statement-breakpoint
ALTER TABLE sudoku_duel_matches DROP COLUMN IF EXISTS deadline_at;
