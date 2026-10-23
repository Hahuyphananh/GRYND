-- 0228_dominoes_ai.sql
--
-- FREE PRACTICE VS THE BOT — the columns that declare a Dominoes row a
-- practice match.
--
-- `is_ai` says the second seat is the built-in bot, not a player: such a row is
-- never listed as an open lobby (the seat is occupied from the start), it can
-- never be joined by a stranger, and settlement skips ratings, trophies and the
-- account W/L counters — a practice win only unlocks the daily reward, exactly
-- like every other game's free practice mode.
--
-- `ai_difficulty` records the tier the bot was started at (`easy | normal |
-- hard`, the shared scale in src/lib/aiDifficulty.ts). It is NULL on PvP rows
-- and is never read as an input from the client after creation.
--
-- Additive and idempotent: safe to re-run. Existing rows are PvP, so the
-- default of `false` is correct for all of them.

ALTER TABLE "dominoes_matches"
  ADD COLUMN IF NOT EXISTS "is_ai" boolean NOT NULL DEFAULT false;

ALTER TABLE "dominoes_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);
