ALTER TABLE "coin_flip_games"
ALTER COLUMN "player1_choice" DROP NOT NULL;

ALTER TABLE "coin_flip_games"
ADD COLUMN "choice_deadline" timestamp;
