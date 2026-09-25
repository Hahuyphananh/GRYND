-- AI match difficulty — one shared easy/normal/hard scale.
--
-- Every free human-vs-AI match now records the tier the player picked in the
-- lobby before starting (the shared `AiDifficultyPicker`), so the server AI
-- can actually play to it instead of running one fixed policy. Before this,
-- only dice-flush / pool-masters / crash-arena honoured a tier; the other
-- AI games had nothing to store one on.
--
-- The vocabulary is the canonical `easy | normal | hard` from
-- `src/lib/aiDifficulty.ts`; `coerceAiDifficulty` maps any legacy spelling
-- (a client that still sends `medium`, chess's 1–5 levels, …) onto it, so the
-- column only ever holds a canonical value. It is NULLABLE with no default:
-- NULL means "nothing was chosen" — i.e. a PvP row, or a match created before
-- this migration — and both read back as the `normal` default. Free AI matches
-- are unstaked, so a row's value is display/behaviour only and never touches
-- balances.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS), so it can also be
-- pasted straight into the Supabase SQL editor.

ALTER TABLE "blackjack_pvp_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "dots_and_boxes_games"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "keno_pvp_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "memory_grid_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "mines_pvp_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "plinko_pvp_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "roulette_pvp_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "precision_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "tower_arena_matches"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "uno_games"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

ALTER TABLE "odds_games"
  ADD COLUMN IF NOT EXISTS "ai_difficulty" varchar(16);

COMMENT ON COLUMN "blackjack_pvp_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "dots_and_boxes_games"."ai_difficulty" IS
  'AI tier for a free vs-AI game: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "keno_pvp_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "memory_grid_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "mines_pvp_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "plinko_pvp_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "roulette_pvp_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "precision_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "tower_arena_matches"."ai_difficulty" IS
  'AI tier for a free vs-AI match: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "uno_games"."ai_difficulty" IS
  'AI tier for a free vs-AI game: easy | normal | hard (NULL = normal)';
COMMENT ON COLUMN "odds_games"."ai_difficulty" IS
  'AI tier for a free vs-AI game: easy | normal | hard (NULL = normal)';
