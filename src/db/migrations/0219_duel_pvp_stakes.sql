-- Migration 0219 — the five remaining duel lobbies play for coins.
--
-- Sudoku Duel, Solitaire Duel, Barricade, Mini Golf and Speed Typing shipped
-- unstaked ("no wagers / no tokens / no payouts"). Their lobbies are already
-- server-owned (one open `waiting` row per stake, claimed atomically, settled by
-- `settleMatch`), so the only missing piece was the stake itself.
--
-- `stake_amount` is NOT NULL DEFAULT 0 so every existing row keeps its meaning:
-- 0 is a free match (a practice match against the bot, or a row written before
-- wagering returned). The settlement path only pays when the stake is positive
-- AND the escrow ledger holds the matching debit row for that seat, so a legacy
-- row can never mint coins.
--
-- Idempotent: safe to re-run (ADD COLUMN / CREATE INDEX IF NOT EXISTS), so it
-- can also be pasted straight into the Supabase SQL editor.

ALTER TABLE "sudoku_duel_matches"
  ADD COLUMN IF NOT EXISTS "stake_amount" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "house_fee" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0';

ALTER TABLE "solitaire_duel_matches"
  ADD COLUMN IF NOT EXISTS "stake_amount" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "house_fee" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0';

ALTER TABLE "barricade_matches"
  ADD COLUMN IF NOT EXISTS "stake_amount" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "house_fee" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0';

ALTER TABLE "mini_golf_matches"
  ADD COLUMN IF NOT EXISTS "stake_amount" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "house_fee" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0';

ALTER TABLE "speed_typing_matches"
  ADD COLUMN IF NOT EXISTS "stake_amount" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "house_fee" numeric(10, 2) NOT NULL DEFAULT '0',
  ADD COLUMN IF NOT EXISTS "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0';

COMMENT ON COLUMN "sudoku_duel_matches"."stake_amount" IS
  'Coins each seat escrows (0 = free / practice); the winner is paid 2 × stake × (1 − rake)';
COMMENT ON COLUMN "solitaire_duel_matches"."stake_amount" IS
  'Coins each seat escrows (0 = free / practice); the winner is paid 2 × stake × (1 − rake)';
COMMENT ON COLUMN "barricade_matches"."stake_amount" IS
  'Coins each seat escrows (0 = free / practice); the winner is paid 2 × stake × (1 − rake)';
COMMENT ON COLUMN "mini_golf_matches"."stake_amount" IS
  'Coins each seat escrows (0 = free / practice); the winner is paid 2 × stake × (1 − rake)';
COMMENT ON COLUMN "speed_typing_matches"."stake_amount" IS
  'Coins each seat escrows (0 = free / practice); the winner is paid 2 × stake × (1 − rake)';

-- Staked matchmaking: "the open lobby at this stake" (mirrors
-- tic_tac_toe_matches_stake_open_idx / memory_grid_stake_open_idx).
CREATE INDEX IF NOT EXISTS "sudoku_duel_matches_stake_open_idx"
  ON "sudoku_duel_matches" ("stake_amount", "status");
CREATE INDEX IF NOT EXISTS "solitaire_duel_matches_stake_open_idx"
  ON "solitaire_duel_matches" ("stake_amount", "status");
CREATE INDEX IF NOT EXISTS "barricade_matches_stake_open_idx"
  ON "barricade_matches" ("stake_amount", "status");
CREATE INDEX IF NOT EXISTS "mini_golf_matches_stake_open_idx"
  ON "mini_golf_matches" ("stake_amount", "status");
CREATE INDEX IF NOT EXISTS "speed_typing_matches_stake_open_idx"
  ON "speed_typing_matches" ("stake_amount", "status");
