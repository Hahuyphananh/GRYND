-- 0254_solitaire_puzzle_moves.sql
--
-- THE PUZZLE RECORDS A MOVE, NOT A LETTER — EXPAND STEP ONLY.
--
-- WHY
--   The puzzle used to be three labelled choices ("A" | "B" | "C"). It is now
--   played on a real Klondike board: the player moves a card (or draws), the
--   server checks that move with the engine and compares it to the proven
--   winning move. A letter can no longer describe what was played.
--
-- WHY AN EXPAND, NOT A RENAME
--   The release pipeline never runs migrations (deploy/README.md), so the
--   schema has to be safe for the version that is live WHILE this file is
--   applied and for the version that replaces it. A rename would break the
--   running app's INSERT (it still writes `choice`) and the new app's INSERT (it
--   writes `move`) in opposite order, whichever way round the two happen. So
--   this migration only ADDS:
--
--     * `move` varchar(160) — the played move as JSON, written by the new code;
--     * `choice` becomes nullable and loses its A/B/C CHECK, so a row written by
--       the new code (which has no letter) is valid, while the live version can
--       keep writing letters until it is replaced.
--
--   Every row written before this migration keeps its letter in `choice`; the
--   new reader parses `move` and falls back to null, so old attempts still
--   report their recorded verdict. Dropping `choice` is a later CONTRACT
--   migration, once no deployed version writes it (the documented
--   expand → deploy → contract path).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the two alterations are safe to
-- repeat.

ALTER TABLE "solitaire_puzzle_attempts"
  ADD COLUMN IF NOT EXISTS "move" varchar(160);

ALTER TABLE "solitaire_puzzle_attempts"
  ALTER COLUMN "choice" DROP NOT NULL;

ALTER TABLE "solitaire_puzzle_attempts"
  DROP CONSTRAINT IF EXISTS "solitaire_puzzle_attempts_choice_check";

COMMENT ON COLUMN "solitaire_puzzle_attempts"."move" IS
  'The move the player played, as JSON (the engine''s SolitaireMove union). Legacy rows keep their letter in choice; this column is null for them.';

COMMENT ON COLUMN "solitaire_puzzle_attempts"."choice" IS
  'Legacy A/B/C answer from the three-choice puzzle UI. Null for board-played puzzles; retained until the contract migration.';
