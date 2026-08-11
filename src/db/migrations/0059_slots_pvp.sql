-- Migration 0059 — PvP Slots tables.
--
-- Adds the server-authoritative schema for the new 1v1 PvP Slots match
-- system (best-of-5, max 5 spins). Two players stake on a shared slot
-- theme; each round both players spin a 3x3 reel grid and the player
-- with the higher spin win-amount wins the round. The match is decided
-- by rounds won (rounds_won_player1/2 — first to 3 wins); if level
-- after 5 spins, the aggregate spin win-amounts (p1_score/p2_score)
-- break the tie.
--
-- Match flow:
--   waiting -> ready -> spin_1 -> spin_2 -> spin_3 -> spin_4 -> spin_5 -> finished
--   (waiting/ready/active -> cancelled for AFK cancels)
--
-- Payout (90/10 split, mirrors plinko-pvp / mines-pvp / roulette-pvp):
--   Winner: own stake back + 90% of loser's stake (1.9x net)
--   Loser:  loses entire stake
--   House:  10% rake on loser's stake only
--   Tied:   both refunded, no rake
--
-- Schema conventions identical to other PvP tables:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * stake/financials as numeric(10, 2)
--   * pgEnum for `status` keeps the 9 match states strongly typed
--   * `slots_pvp_rounds` cascades from `slots_pvp_matches`
--
-- Note: the existing solo `slot_games` / `slot_jackpots` tables are
-- intentionally LEFT IN PLACE — PvP slots is purely additive and reuses
-- the solo themes (src/lib/slotThemes.jsx) for reel rendering.

CREATE TYPE "slots_pvp_status" AS ENUM ('waiting', 'ready', 'spin_1', 'spin_2', 'spin_3', 'spin_4', 'spin_5', 'finished', 'cancelled');--> statement-breakpoint

CREATE TABLE "slots_pvp_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"player1_id" varchar(255) NOT NULL,
	"player2_id" varchar(255),
	"stake_amount" numeric(10, 2) NOT NULL,
	"theme" varchar(40) DEFAULT 'fruit' NOT NULL,
	"status" "slots_pvp_status" DEFAULT 'waiting' NOT NULL,
	"current_spin" integer DEFAULT 1 NOT NULL,
	"rounds_won_player1" integer DEFAULT 0 NOT NULL,
	"rounds_won_player2" integer DEFAULT 0 NOT NULL,
	"p1_score" integer DEFAULT 0 NOT NULL,
	"p2_score" integer DEFAULT 0 NOT NULL,
	"p1_current_inputs" jsonb,
	"p2_current_inputs" jsonb,
	"round_deadline" timestamp,
	"round_timer_seconds" integer DEFAULT 20 NOT NULL,
	"winner_id" varchar(255),
	"result" varchar(20),
	"house_fee" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"prize_paid" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "slots_pvp_rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"spin_number" integer NOT NULL,
	"player1_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player2_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player1_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player2_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player1_auto_spun" boolean DEFAULT false NOT NULL,
	"player2_auto_spun" boolean DEFAULT false NOT NULL,
	"spin_points_player1" integer DEFAULT 0 NOT NULL,
	"spin_points_player2" integer DEFAULT 0 NOT NULL,
	"round_winner" varchar(10),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "slots_pvp_rounds" ADD CONSTRAINT "slots_pvp_rounds_match_id_slots_pvp_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "slots_pvp_matches"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX "slots_pvp_status_idx" ON "slots_pvp_matches" ("status","created_at");--> statement-breakpoint

CREATE INDEX "slots_pvp_player1_idx" ON "slots_pvp_matches" ("player1_id","created_at");--> statement-breakpoint

CREATE INDEX "slots_pvp_player2_idx" ON "slots_pvp_matches" ("player2_id","created_at");--> statement-breakpoint

CREATE INDEX "slots_pvp_stake_open_idx" ON "slots_pvp_matches" ("stake_amount","status");--> statement-breakpoint

CREATE INDEX "slots_pvp_rounds_match_spin_idx" ON "slots_pvp_rounds" ("match_id","spin_number");
