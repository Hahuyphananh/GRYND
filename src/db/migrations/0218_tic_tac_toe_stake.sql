-- Migration 0218 — Tic-Tac-Toe Duel plays for coins.
--
-- Every ranked duel in the catalogue escrows a wager: both seats are funded the
-- moment the second player takes the seat and the winner is paid out of that
-- escrow on settle. Tic-Tac-Toe shipped unstaked ("There is deliberately NO
-- stake_amount column", 0192), so it is the last lobby-style game whose result
-- the SERVER already owns — `settleMatch` derives the winner from the board on
-- the row — that could not move coins.
--
-- `stake_amount` is NOT NULL DEFAULT 0 so every existing row keeps its meaning:
-- 0 is a free match (a practice match against the bot, or a row written before
-- wagering returned), and the settlement path only pays when the stake is
-- positive AND the escrow ledger holds the matching debit row, so a legacy row
-- can never mint coins.
--
-- Idempotent: safe to re-run (ADD COLUMN / CREATE INDEX IF NOT EXISTS), so it
-- can also be pasted straight into the Supabase SQL editor.

ALTER TABLE "tic_tac_toe_matches"
  ADD COLUMN IF NOT EXISTS "stake_amount" numeric(10, 2) NOT NULL DEFAULT '0';

COMMENT ON COLUMN "tic_tac_toe_matches"."stake_amount" IS
  'Coins each seat puts up (0 = free / practice match); the winner is paid 2 × stake × (1 − rake)';

-- Staked matchmaking: "the open lobby at this stake" (mirrors
-- memory_grid_stake_open_idx / mines_pvp_stake_open_idx).
CREATE INDEX IF NOT EXISTS "tic_tac_toe_matches_stake_open_idx"
  ON "tic_tac_toe_matches" ("stake_amount", "status");
