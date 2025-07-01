CREATE TABLE "coin_flip_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"player1_id" varchar(255) NOT NULL,
	"player2_id" varchar(255),
	"bet_amount" numeric(10, 2) NOT NULL,
	"player1_choice" varchar(10) NOT NULL,
	"outcome" varchar(10),
	"winner_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poker_player_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"game_id" integer NOT NULL,
	"player_id" integer,
	"position" integer NOT NULL,
	"stack" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"current_bet" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"has_folded" varchar(5) DEFAULT 'false' NOT NULL,
	"is_all_in" varchar(5) DEFAULT 'false' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "pot" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "min_bet" numeric(10, 2) DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "player_hand" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "ai_hand" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "deck" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "current_player_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "dealer_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "current_round" varchar(10) DEFAULT 'preflop' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clerk_id" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ADD CONSTRAINT "poker_player_positions_game_id_poker_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."poker_games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id");