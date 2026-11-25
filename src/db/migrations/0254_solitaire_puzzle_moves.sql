-- 0254_solitaire_puzzle_moves.sql
--
-- THE PUZZLE RECORDS A MOVE, NOT A LETTER.
--
-- WHY
--   The puzzle used to be three labelled choices ("A" | "B" | "C"). It is now
--   played on a real Klondike board: the player moves a card (or draws), the
--   server checks that move with the engine and compares it to the proven
--   winning move. A letter can no longer describe what was played.
--
-- WHY EVERY STATEMENT IS GUARDED
--   Two facts make a plain rename wrong:
--
--   1. The release pipeline never runs migrations (deploy/README.md), so this
--      file is applied by hand, in whatever order the operator chooses relative
--      to the release.
--   2. The production table has ALREADY been changed outside the migrator: it
--      has `move` (varchar(160), NOT NULL) and no `choice` at all, while
--      drizzle's `__drizzle_migrations` journal is behind the live schema.
--
--   An unguarded `ADD COLUMN choice` or `ALTER COLUMN choice` would therefore
--   fail on production, and a bare rename would fail where `move` already
--   exists. So this migration only ADDS what is missing and relaxes the legacy
--   column IF it is still there. On production it is a no-op; on a database
--   that still has the three-choice schema it performs the expand.
--
--   Legacy rows that hold a letter keep it in `choice`; the new reader parses
--   `move` and falls back to null, so old attempts still report their recorded
--   verdict. Dropping `choice` is a later CONTRACT step, once no deployed
--   version writes it.
--
-- Idempotent by construction: no statement depends on the previous one having
-- changed anything.

ALTER TABLE "solitaire_puzzle_attempts"
  ADD COLUMN IF NOT EXISTS "move" varchar(160);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'solitaire_puzzle_attempts'
       AND column_name = 'choice'
  ) THEN
    ALTER TABLE "solitaire_puzzle_attempts" ALTER COLUMN "choice" DROP NOT NULL;
    ALTER TABLE "solitaire_puzzle_attempts"
      DROP CONSTRAINT IF EXISTS "solitaire_puzzle_attempts_choice_check";
    COMMENT ON COLUMN "solitaire_puzzle_attempts"."choice" IS
      'Legacy A/B/C answer from the three-choice puzzle UI. Null for board-played puzzles; retained until the contract migration.';
  END IF;
END $$;

COMMENT ON COLUMN "solitaire_puzzle_attempts"."move" IS
  'The move the player played, as JSON (the engine''s SolitaireMove union). Legacy rows keep their letter in choice; this column is null for them.';
