-- Migration 0182 — Mini Golf AI difficulty.
--
-- Mini Golf gained an easy | normal | hard practice bot after 0166 had already
-- added `ai_difficulty` to the other AI match tables, so its row needed the same
-- column (the shared `AiDifficultyPicker` / `coerceAiDifficulty` scale lives in
-- `src/lib/aiDifficulty.ts`).
--
-- NULLABLE with no default: NULL means "nothing was chosen" — a human duel, or
-- a practice match created before this migration — and reads back as the
-- mini-golf default, `hard`, which is exactly the bot that shipped before the
-- tiers existed. Free AI matches are unstaked, so the value is
-- behaviour/display only and never touches balances.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS), so it can also be
-- pasted straight into the Supabase SQL editor.

ALTER TABLE "mini_golf_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

COMMENT ON COLUMN "mini_golf_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = hard)';
