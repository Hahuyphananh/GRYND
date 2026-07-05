-- Migration 0048 — Plinko Duel PvP tables.
--
-- Adds the server-authoritative schema for the new skill-based PvP
-- Plinko ("Plinko Duel") match system. Two players launch 3 balls
-- each on a SHARED Plinko board. The player with the higher
-- cumulative base-points across all 3 balls wins the match.
--
-- Match flow:
--   waiting → ready → ball_1 → ball_2 → ball_3 → finished
--   (waiting/ready/active → cancelled for AFK cancels)
--
-- Per-ball scoring (bucket table from `lib/plinko-pvp/constants.js`):
--   Far left safe  (x ∈ [0,100))   → 100 points
--   Left precision (x ∈ [100,200)) → 140 points
--   Center trap    (x ∈ [200,300)) →  40 points
--   Right precision(x ∈ [300,400)) → 140 points
--   Far right safe (x ∈ [400,500)) → 100 points
--   FELL OUT (x < 0 || x > 500 before y reaches bucket row) → 0 points
--
-- Payout (90/10 split, mirrors mines-pvp / roulette-pvp):
--   Winner: own stake back + 90% of loser's stake (1.9× net)
--   Loser:   loses entire stake
--   House:   10% rake on loser's stake only
--   Tied:    both refunded, no rake
--
-- Schema conventions identical to other PvP tables:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * stake/financials as numeric(10, 2)
--   * pgEnum for `status` keeps the 7 match states strongly typed
--   * `plinko_pvp_rounds` cascades from `plinko_pvp_matches`
--
-- Note: the legacy `plinko_games` table is intentionally LEFT IN
-- PLACE here. It is retired in a later cleanup migration once the
-- solo Plinko UI is fully removed (see Plinko Duel deletion task).

CREATE TYPE "plinko_pvp_status" AS ENUM ('waiting', 'ready', 'ball_1', 'ball_2', 'ball_3', 'finished', 'cancelled');--> statement-breakpoint

CREATE TYPE "plinko_pvp_ball_outcome" AS ENUM ('p1', 'p2', 'tie');

CREATE TABLE "plinko_pvp_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"player1_id" varchar(255) NOT NULL,
	"player2_id" varchar(255),
	"stake_amount" numeric(10, 2) NOT NULL,
	"status" "plinko_pvp_status" DEFAULT 'waiting' NOT NULL,
	"current_ball" integer DEFAULT 1 NOT NULL,
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

CREATE TABLE "plinko_pvp_rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"ball_number" integer NOT NULL,
	"player1_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player2_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player1_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player2_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"player1_auto_launched" boolean DEFAULT false NOT NULL,
	"player2_auto_launched" boolean DEFAULT false NOT NULL,
	"ball_points_player1" integer DEFAULT 0 NOT NULL,
	"ball_points_player2" integer DEFAULT 0 NOT NULL,
	"ball_outcome" "plinko_pvp_ball_outcome",
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "plinko_pvp_rounds" ADD CONSTRAINT "plinko_pvp_rounds_match_id_plinko_pvp_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "plinko_pvp_matches"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX "plinko_pvp_status_idx" ON "plinko_pvp_matches" ("status","created_at");--> statement-breakpoint

CREATE INDEX "plinko_pvp_player1_idx" ON "plinko_pvp_matches" ("player1_id","created_at");--> statement-breakpoint

CREATE INDEX "plinko_pvp_player2_idx" ON "plinko_pvp_matches" ("player2_id","created_at");--> statement-breakpoint

CREATE INDEX "plinko_pvp_stake_open_idx" ON "plinko_pvp_matches" ("stake_amount","status");--> statement-breakpoint

CREATE INDEX "plinko_pvp_rounds_match_ball_idx" ON "plinko_pvp_rounds" ("match_id","ball_number");
