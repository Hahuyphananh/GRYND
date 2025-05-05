CREATE TABLE "blackjack_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"result" varchar(10) NOT NULL,
	"payout" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chess_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"player_white_id" integer NOT NULL,
	"player_black_id" integer,
	"bet_amount" numeric(10, 2) NOT NULL,
	"winner_id" integer,
	"result" varchar(20),
	"payout" numeric(10, 2),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crash_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"cashed_out_at" numeric(10, 2),
	"payout" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"sport_id" integer NOT NULL,
	"team_a" varchar(100) NOT NULL,
	"team_b" varchar(100) NOT NULL,
	"start_time" timestamp NOT NULL,
	"odds_a" numeric(5, 2) NOT NULL,
	"odds_b" numeric(5, 2) NOT NULL,
	"odds_draw" numeric(5, 2),
	"status" varchar(20) DEFAULT 'upcoming'
);
--> statement-breakpoint
CREATE TABLE "mines_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"tiles_revealed" integer DEFAULT 0,
	"payout" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plinko_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"result_multiplier" numeric(10, 2) NOT NULL,
	"payout" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poker_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"result" varchar(10) NOT NULL,
	"payout" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roulette_games" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"result" varchar(10) NOT NULL,
	"payout" numeric(10, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sports_bets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"bet_amount" numeric(10, 2) NOT NULL,
	"choice" varchar(100) NOT NULL,
	"odds" numeric(5, 2) NOT NULL,
	"payout" numeric(10, 2),
	"result" varchar(20),
	"placed_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password" varchar(255) NOT NULL,
	"age" integer,
	"balance" numeric(10, 2) DEFAULT '1000.00' NOT NULL,
	"games_won" integer DEFAULT 0,
	"games_lost" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
