CREATE TABLE "chess_moves" (
  "id" serial PRIMARY KEY NOT NULL,
  "game_id" integer NOT NULL,
  "played_by" varchar(255) NOT NULL,
  "move_uci" varchar(10) NOT NULL,
  "move_san" varchar(20) NOT NULL,
  "fen_after" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chess_moves" ADD CONSTRAINT "chess_moves_game_id_chess_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."chess_games"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "chess_moves_game_idx" ON "chess_moves" USING btree ("game_id");
