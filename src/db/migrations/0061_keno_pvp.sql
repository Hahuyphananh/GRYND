-- Migration 0061 — PvP Keno tables ("Keno Catch Duel").
--
-- Adds the server-authoritative schema for the new 1v1 PvP Keno match
-- system. Replaces the removed solo keno (keno_games stays for bet
-- history / sitemap; new matches are recorded here).
--
-- Match flow:
--   waiting -> ready -> round_1 -> round_2 -> round_3 -> round_4 -> round_5 -> finished
--   (waiting/ready/round_N -> cancelled for AFK cancels / forfeits)
--
-- Skill loop (mirrors the slots-pvp timing mechanic):
--   * Both players face the SAME shared draw of 10 balls (1-40) every
--     round. Balls are released one at a time on a fixed schedule
--     (see src/lib/keno-pvp/constants.js); each player taps a ball to
--     catch it and the server grades the tap against the ball's ideal
--     catch instant (perfect / good / late — missing the window means
--     the ball is gone).
--   * Round score = keno multiplier for the number caught (the classic
--     KENO_MULTIPLIER_TABLE — catching more pays exponentially) plus a
--     flat +5 per perfect-timed catch. Higher score wins the round;
--     best of 5 rounds, first to 3 round wins takes the match.
--
-- Payout (90/10 split, mirrors slots-pvp / mines-pvp / roulette-pvp):
--   Winner: own stake back + 90% of loser's stake (1.9x net)
--   Loser:  loses entire stake
--   House:  10% rake on loser's stake only
--   Draw:   both refunded, no rake
--
-- Schema conventions identical to the other PvP tables:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * stake/financials as numeric(10, 2)
--   * pgEnum `keno_pvp_status` for the 9 match states
--   * `keno_pvp_rounds` cascades from `keno_pvp_matches`

CREATE TYPE "keno_pvp_status" AS ENUM ('waiting', 'ready', 'round_1', 'round_2', 'round_3', 'round_4', 'round_5', 'finished', 'cancelled');--> statement-breakpoint

CREATE TABLE "keno_pvp_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"player1_id" varchar(255) NOT NULL,
	"player2_id" varchar(255),
	"stake_amount" numeric(10, 2) NOT NULL,
	"status" "keno_pvp_status" DEFAULT 'waiting' NOT NULL,
	"current_round" integer DEFAULT 1 NOT NULL,
	"rounds_won_player1" integer DEFAULT 0 NOT NULL,
	"rounds_won_player2" integer DEFAULT 0 NOT NULL,
	"p1_score" integer DEFAULT 0 NOT NULL,
	"p2_score" integer DEFAULT 0 NOT NULL,
	"current_draw" jsonb,
	"p1_catches" jsonb,
	"p2_catches" jsonb,
	"round_deadline" timestamp,
	"round_timer_seconds" integer DEFAULT 15 NOT NULL,
	"winner_id" varchar(255),
	"result" varchar(20),
	"house_fee" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"prize_paid" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "keno_pvp_rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" integer NOT NULL,
	"round_number" integer NOT NULL,
	"shared_draw" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"player1_catches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"player2_catches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"player1_score" integer DEFAULT 0 NOT NULL,
	"player2_score" integer DEFAULT 0 NOT NULL,
	"round_winner" varchar(10),
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "keno_pvp_rounds" ADD CONSTRAINT "keno_pvp_rounds_match_id_keno_pvp_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "keno_pvp_matches"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX "keno_pvp_status_idx" ON "keno_pvp_matches" ("status","created_at");--> statement-breakpoint

CREATE INDEX "keno_pvp_player1_idx" ON "keno_pvp_matches" ("player1_id","created_at");--> statement-breakpoint

CREATE INDEX "keno_pvp_player2_idx" ON "keno_pvp_matches" ("player2_id","created_at");--> statement-breakpoint

CREATE INDEX "keno_pvp_stake_open_idx" ON "keno_pvp_matches" ("stake_amount","status");--> statement-breakpoint

CREATE INDEX "keno_pvp_rounds_match_round_idx" ON "keno_pvp_rounds" ("match_id","round_number");
