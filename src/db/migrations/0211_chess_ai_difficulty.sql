-- ── 0211: Chess VS-AI difficulty, persisted on the match row ────────────────
--
-- WHY THE TIER IS STORED AT ALL
--   Chess VS-AI ships three tiers (easy | medium | hard) and, until now, the
--   tier existed ONLY in the browser: `/api/chess/create-ai-game` echoed the
--   requested number back to the client and stored nothing, so the row could not
--   say how strong its opponent had been. Once the server generates the AI's
--   moves, the row must record the settings that PRODUCED its own move history
--   or the history is not auditable — an evaluation can then name the bot it
--   analysed instead of guessing.
--
-- WHY THE COLUMN IS NULLABLE
--   `is_ai_game = false` rows are PvP or lobby rows. They have no bot and
--   therefore no tier, and stamping them with a meaningless 'medium' would make
--   "which rows have a tier?" unanswerable. NULL is that meaning, exactly as
--   `ai_difficulty` is nullable on every other AI-capable table in this schema
--   (see migration 0195 for the vocabulary this follows).
--
-- THE BACKFILL
--   Pre-existing AI rows (created before this migration) carry no tier. They are
--   set to 'medium' — the documented default in src/lib/chessDifficulty.ts
--   (`DEFAULT_CHESS_AI_DIFFICULTY`), which is also what a NULL coerces to at read
--   time, so the column and the reader agree rather than disagreeing by one row.
--   Only AI rows are touched; PvP rows stay NULL.
--
-- IDEMPOTENT AND ADDITIVE
--   `ADD COLUMN IF NOT EXISTS`, a backfill that only ever fills NULLs, and a
--   constraint guarded on `pg_constraint`. Re-running the whole file is a no-op.
--   No table is created, no column is dropped, and nothing about stakes, payouts
--   or seats is touched.
--
-- This file must stay registered in meta/_journal.json: the migrator walks the
-- journal, not the directory, so an unjournaled .sql is never applied and every
-- query that reads the column 500s. tests/migration-journal-guard.test.mjs
-- enforces that.

ALTER TABLE "chess_games"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" VARCHAR(16);
--> statement-breakpoint

UPDATE "chess_games"
   SET "ai_difficulty" = 'medium'
 WHERE "is_ai_game" = true
   AND "ai_difficulty" IS NULL;
--> statement-breakpoint

-- The vocabulary is CLOSED, and NULL is the only value outside it. A bad tier
-- then fails at the write instead of being silently coerced into a tier nobody
-- chose — the same shape 0209 uses for the Speed Typing device classes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'chess_games' AND n.nspname = 'public'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chess_games_ai_difficulty_valid'
  ) THEN
    ALTER TABLE "chess_games"
      ADD CONSTRAINT "chess_games_ai_difficulty_valid"
      CHECK ("ai_difficulty" IS NULL OR "ai_difficulty" IN ('easy', 'medium', 'hard'));
  END IF;
END $$;
