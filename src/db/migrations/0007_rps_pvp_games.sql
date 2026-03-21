DO $$ BEGIN
  CREATE TYPE "rps_pvp_status" AS ENUM ('active', 'matched', 'finished', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "rps_pvp_games" (
  "id" serial PRIMARY KEY NOT NULL,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "bet_amount" numeric(10,2) NOT NULL,
  "player1_choice" varchar(20),
  "player2_choice" varchar(20),
  "outcome" varchar(20),
  "winner_id" varchar(255),
  "result" varchar(20) DEFAULT 'pending' NOT NULL,
  "status" "rps_pvp_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "rps_pvp_open_games_idx" ON "rps_pvp_games" ("player2_id");
CREATE INDEX IF NOT EXISTS "rps_pvp_status_idx" ON "rps_pvp_games" ("status");
