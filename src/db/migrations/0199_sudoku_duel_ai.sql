-- 0199: Sudoku Duel practice-bot difficulty.
--
-- Sudoku Duel gains a free "play vs AI" mode. `is_ai` already existed (it was
-- reserved for exactly this and is now written by createAiMatch); this adds the
-- tier picked in the lobby ('easy' | 'normal' | 'hard'), mirroring the
-- `ai_difficulty` columns Tic-Tac-Toe / Solitaire Duel / Mini Golf already carry.
-- NULL falls back to the documented default at read time. Additive and
-- idempotent, exactly like every other column-adding migration.

ALTER TABLE "sudoku_duel_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);
