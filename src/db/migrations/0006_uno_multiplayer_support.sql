ALTER TABLE "uno_games"
  ADD COLUMN IF NOT EXISTS "player2_id" integer,
  ADD COLUMN IF NOT EXISTS "top_card" json;

ALTER TABLE "uno_games"
  ALTER COLUMN "winner" SET DEFAULT 'pending';

UPDATE "uno_games"
SET "winner" = 'pending'
WHERE "winner" IS NULL OR "winner" = '';
