-- ── Missing migrations: tables that exist in schema.ts but were never
-- created by any migration file (previously applied only via
-- `drizzle-kit push`). Recreated here so a fresh database built from the
-- migration chain matches the schema the app expects.
-- Tables: user_presence, user_login_rewards, connect_four_games,
-- dice_flush_rooms, dice_flush_players, dice_flush_actions,
-- lane_runner_pvp_matches + the presence_status / lane_runner_pvp_status enums.

DO $$ BEGIN
  CREATE TYPE "presence_status" AS ENUM ('online', 'in_game', 'offline');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "lane_runner_pvp_status" AS ENUM ('waiting', 'ready', 'p1_turn', 'p2_turn', 'finished', 'cancelled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_presence" (
  "clerk_id" varchar(255) PRIMARY KEY NOT NULL,
  "last_seen" timestamp DEFAULT now() NOT NULL,
  "status" "presence_status" DEFAULT 'offline' NOT NULL,
  "current_game_id" varchar(255),
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_presence_status_seen_idx" ON "user_presence" ("status", "last_seen");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_login_rewards" (
  "user_id" integer PRIMARY KEY NOT NULL REFERENCES "users"("id"),
  "current_day" integer DEFAULT 1,
  "last_claimed_date" date
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connect_four_games" (
  "id" serial PRIMARY KEY NOT NULL,
  "host_clerk_id" varchar(255) NOT NULL,
  "guest_clerk_id" varchar(255),
  "bet_amount" numeric(10,2) NOT NULL,
  "status" varchar(30) DEFAULT 'waiting' NOT NULL,
  "board" jsonb DEFAULT '[[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0],[0,0,0,0,0,0,0]]'::jsonb NOT NULL,
  "host_discs_used" integer DEFAULT 0 NOT NULL,
  "guest_discs_used" integer DEFAULT 0 NOT NULL,
  "current_turn" varchar(10) DEFAULT 'host' NOT NULL,
  "winner_clerk_id" varchar(255),
  "result" varchar(30),
  "payout" numeric(10,2),
  "move_deadline_at" timestamp,
  "timer_seconds" integer DEFAULT 60 NOT NULL,
  "host_replay_decision" varchar(10),
  "guest_replay_decision" varchar(10),
  "replay_deadline_at" timestamp,
  "next_game_id" integer,
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connect_four_status_idx" ON "connect_four_games" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connect_four_host_idx" ON "connect_four_games" ("host_clerk_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connect_four_guest_idx" ON "connect_four_games" ("guest_clerk_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dice_flush_rooms" (
  "id" varchar(120) PRIMARY KEY NOT NULL,
  "status" varchar(20) NOT NULL,
  "wager" integer NOT NULL,
  "pot" integer NOT NULL,
  "game_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dice_flush_rooms_status" ON "dice_flush_rooms" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dice_flush_players" (
  "id" serial PRIMARY KEY NOT NULL,
  "room_id" varchar(120) REFERENCES "dice_flush_rooms"("id"),
  "user_id" varchar(255) NOT NULL,
  "is_ai" boolean DEFAULT false,
  "score" integer DEFAULT 0,
  "created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dice_flush_players_room_id" ON "dice_flush_players" ("room_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dice_flush_actions" (
  "id" serial PRIMARY KEY NOT NULL,
  "room_id" varchar(120),
  "user_id" varchar(255),
  "action_type" varchar(40),
  "payload" jsonb,
  "created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_dice_flush_actions_room_id" ON "dice_flush_actions" ("room_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lane_runner_pvp_matches" (
  "id" serial PRIMARY KEY NOT NULL,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "stake_amount" numeric(10,2) NOT NULL,
  "status" "lane_runner_pvp_status" DEFAULT 'waiting' NOT NULL,
  "difficulty" varchar(20) NOT NULL,
  "p1_tower" jsonb DEFAULT '{"lanes":[]}'::jsonb NOT NULL,
  "p2_tower" jsonb DEFAULT '{"lanes":[]}'::jsonb NOT NULL,
  "first_player_id" varchar(255),
  "current_turn_user_id" varchar(255),
  "p1_lane" integer DEFAULT 0 NOT NULL,
  "p2_lane" integer DEFAULT 0 NOT NULL,
  "p1_held" boolean DEFAULT false NOT NULL,
  "p2_held" boolean DEFAULT false NOT NULL,
  "p1_busted" boolean DEFAULT false NOT NULL,
  "p2_busted" boolean DEFAULT false NOT NULL,
  "actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "round_deadline" timestamp,
  "round_timer_seconds" integer DEFAULT 20 NOT NULL,
  "winner_id" varchar(255),
  "result" varchar(20),
  "house_fee" numeric(10,2) DEFAULT '0.00' NOT NULL,
  "prize_paid" numeric(10,2) DEFAULT '0.00' NOT NULL,
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_runner_pvp_status_idx" ON "lane_runner_pvp_matches" ("status", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_runner_pvp_player1_idx" ON "lane_runner_pvp_matches" ("player1_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_runner_pvp_player2_idx" ON "lane_runner_pvp_matches" ("player2_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lane_runner_pvp_stake_open_idx" ON "lane_runner_pvp_matches" ("stake_amount", "status");
