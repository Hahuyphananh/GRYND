CREATE TABLE "keno_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"numbers_picked" jsonb NOT NULL,
	"numbers_drawn" jsonb NOT NULL,
	"hits" integer NOT NULL,
	"payout" numeric(10, 2) NOT NULL,
	"multiplier" numeric(5, 2) NOT NULL,
	"status" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rps_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"bet_amount" numeric NOT NULL,
	"choice" varchar(20) NOT NULL,
	"ai_choice" varchar(20) NOT NULL,
	"result" varchar(20) NOT NULL,
	"payout" numeric DEFAULT '0',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "slot_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"payout" numeric(10, 2) NOT NULL,
	"result" varchar(10) DEFAULT 'pending' NOT NULL,
	"reels" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tank_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" varchar(255) NOT NULL,
	"clerk_id" varchar(255) NOT NULL,
	"username" varchar(255),
	"bounty" numeric(12, 2) DEFAULT '1.00' NOT NULL,
	"kills" integer DEFAULT 0 NOT NULL,
	"amount_cashed_out" numeric(12, 2) DEFAULT '0.00',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uno_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" text NOT NULL,
	"pot" text NOT NULL,
	"result" text NOT NULL,
	"payout" text NOT NULL,
	"player_hand" json DEFAULT '[]' NOT NULL,
	"ai_hand" json DEFAULT '[]' NOT NULL,
	"player1_hand" json DEFAULT '[]' NOT NULL,
	"player2_hand" json DEFAULT '[]' NOT NULL,
	"deck" json NOT NULL,
	"discard_pile" json NOT NULL,
	"turn" text NOT NULL,
	"current_color" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"winner" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poker_games" RENAME COLUMN "current_round" TO "round";--> statement-breakpoint
ALTER TABLE "poker_games" RENAME COLUMN "min_bet" TO "current_bet";--> statement-breakpoint
ALTER TABLE "poker_player_positions" DROP CONSTRAINT "poker_player_positions_game_id_poker_games_id_fk";
--> statement-breakpoint
ALTER TABLE "chess_games" ALTER COLUMN "player_white_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "chess_games" ALTER COLUMN "player_black_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "chess_games" ALTER COLUMN "winner_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "plinko_games" ALTER COLUMN "user_id" SET DATA TYPE varchar(255) USING "user_id"::varchar(255);--> statement-breakpoint
ALTER TABLE "plinko_games" ALTER COLUMN "result_multiplier" SET DATA TYPE varchar(255) USING "result_multiplier"::varchar(255);--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "status" SET DEFAULT 'waiting';--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "pot" SET DATA TYPE text USING "pot"::text;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "pot" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "pot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "player_hand" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "ai_hand" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "deck" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "deck" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "dealer_position" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "poker_games" ALTER COLUMN "dealer_position" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ALTER COLUMN "player_id" SET DEFAULT null;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ALTER COLUMN "stack" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ALTER COLUMN "current_bet" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ALTER COLUMN "has_folded" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ALTER COLUMN "has_folded" SET DATA TYPE boolean USING "has_folded"::boolean;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ALTER COLUMN "has_folded" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "chess_games" ADD COLUMN "is_ai_game" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coin_flip_games" ADD COLUMN "result" varchar(10) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "coin_flip_games" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "crash_games" ADD COLUMN "result" varchar(10) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "crash_games" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "mines_games" ADD COLUMN "result" varchar(10) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "mines_games" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "plinko_games" ADD COLUMN "result" varchar(10) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "plinko_games" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "game_code" varchar(10) DEFAULT substr(md5((random())::text), 1, 10) NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "max_players" integer DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "is_private" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "players" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "current_turn" integer;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "community_cards" jsonb;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "discard_pile" jsonb;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "min_raise" text;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "small_blind" text;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "big_blind" text;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "player_positions" jsonb;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "winner" text;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "winnings" jsonb;--> statement-breakpoint
ALTER TABLE "poker_games" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ADD COLUMN "is_ai" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ADD COLUMN "hand" json DEFAULT '[]'::json NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ADD COLUMN "last_action" text DEFAULT null;--> statement-breakpoint
ALTER TABLE "poker_player_positions" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "poker_games" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "poker_games" DROP COLUMN "bet_amount";--> statement-breakpoint
ALTER TABLE "poker_games" DROP COLUMN "result";--> statement-breakpoint
ALTER TABLE "poker_games" DROP COLUMN "payout";--> statement-breakpoint
ALTER TABLE "poker_games" DROP COLUMN "current_player_position";--> statement-breakpoint
ALTER TABLE "poker_player_positions" DROP COLUMN "is_all_in";--> statement-breakpoint
ALTER TABLE "poker_games" ADD CONSTRAINT "poker_games_game_code_unique" UNIQUE("game_code");