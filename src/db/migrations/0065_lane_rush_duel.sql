-- Migration 0065 — Lane Rush Duel tables.
--
-- Adds the server-authoritative schemoka for the new 1v1 PvP "Lane
-- Rush Duel" match system (the PvP replacement for the solo tower
-- game; lane_runner_games stays for bet history / sitemap).
--
-- Match flow:
--   waiting -> ready -> p1_turn / p2_turn -> finished
--   (waiting/ready/active -> cancelled for AFK cancels)
--
-- Game rules:
--   * Each player races their OWN provably-fair tower (same
--     difficulty, host-chosen at lobby creation). Towers derive from
--     a SHARED server seed (hash shown pre-match, seed revealed
--     post-match) + each player's own client seed + match id nonce.
--   * On your turn (20s window): pick a tile in your current lane
--     (safe -> lane advances, bad -> bust and lose) or HOLD to bank
--     your lane as your final score (the flag-to-win chicken move).
--   * Terminal: bust -> other player wins; completed all 8 lanes ->
--     completer wins; both held -> higher lane wins, equal -> DRAW.
--
-- Payout (90/10 split, mirrors mines-pvp / roulette-pvp):
--   Winner: own stake back + 90% of loser's stake (1.9x net)
--   Loser:  loses entire stake
--   House:  10% rake on loser's stake only
--   Draw:   both refunded, no rake
--
-- Schema conventions identical to the other PvP tables:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * stake/financials as numeric(10, 2)
--   * pgEnum `lane_rush_duel_status` for the 6 match states
--   * `p1_tower` / `p2_tower` jsonb columns are SERVER-ONLY
--     (scrubbed from /status responses until finished)

CREATE TYPE "lane_rush_duel_status" AS ENUM ('waiting', 'ready', 'p1_turn', 'p2_turn', 'finished', 'cancelled');--> statement-breakpoint

CREATE TABLE "lane_rush_duel_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"player1_id" varchar(255) NOT NULL,
	"player2_id" varchar(255),
	"stake_amount" numeric(10, 2) NOT NULL,
	"status" "lane_rush_duel_status" DEFAULT 'waiting' NOT NULL,
	"difficulty" varchar(20) DEFAULT 'easy' NOT NULL,
	"tiles_per_lane" integer DEFAULT 4 NOT NULL,
	"first_player_id" varchar(255),
	"current_turn_user_id" varchar(255),
	"server_seed" varchar(128) NOT NULL,
	"server_seed_hash" varchar(64) NOT NULL,
	"p1_client_seed" varchar(128) NOT NULL,
	"p2_client_seed" varchar(128),
	"p1_tower" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"p2_tower" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"p1_lane" integer DEFAULT 0 NOT NULL,
	"p2_lane" integer DEFAULT 0 NOT NULL,
	"p1_held" boolean DEFAULT false NOT NULL,
	"p2_held" boolean DEFAULT false NOT NULL,
	"p1_points" integer DEFAULT 0 NOT NULL,
	"p2_points" integer DEFAULT 0 NOT NULL,
	"p1_auto_picked" boolean DEFAULT false NOT NULL,
	"p2_auto_picked" boolean DEFAULT false NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"round_deadline" timestamp,
	"round_timer_seconds" integer DEFAULT 20 NOT NULL,
	"winner_id" varchar(255),
	"result" varchar(20),
	"house_fee" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"prize_paid" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"started_at" timestamp,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "lane_rush_duel_status_idx" ON "lane_rush_duel_matches" USING btree ("status","created_at");--> statement-breakpoint

CREATE INDEX "lane_rush_duel_player1_idx" ON "lane_rush_duel_matches" USING btree ("player1_id","created_at");--> statement-breakpoint

CREATE INDEX "lane_rush_duel_player2_idx" ON "lane_rush_duel_matches" USING btree ("player2_id","created_at");--> statement-breakpoint

CREATE INDEX "lane_rush_duel_stake_open_idx" ON "lane_rush_duel_matches" USING btree ("stake_amount","status");--> statement-breakpoint
