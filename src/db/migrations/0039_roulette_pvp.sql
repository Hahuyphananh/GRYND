-- ── Roulette PvP match system ─────────────────────────────────────────
-- Follows the conventions of coin_flip_games / precision_matches:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * stake/financials as numeric(10, 2)
--   * `status` as a pgEnum to mirror coin_flip_games conventions and to
--     keep the 7 match states (waiting, ready, round_1, round_2,
--     round_3, sudden_death, finished) strongly typed
--   * `roulette_pvp_rounds` cascades from `roulette_pvp_matches`
--
-- Win rule per round (single shared spin):
--   Each round starts both players with 100 "points" (the round budget).
--   Players place bets up to their available budget. The same spin
--   result is used for both players' bets. The player with the higher
--   (payout − total_bet) wins the round. Identical net result is a
--   DRAW (no point awarded). After 3 rounds, if score_p1 == score_p2
--   the match transitions to sudden_death; otherwise it goes straight
--   to finished.

-- ── enum ───────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'roulette_pvp_status') THEN
    CREATE TYPE roulette_pvp_status AS ENUM (
      'waiting',
      'ready',
      'round_1',
      'round_2',
      'round_3',
      'sudden_death',
      'finished',
      'cancelled'
    );
  END IF;
END
$$;
--> statement-breakpoint

-- ── matches ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "roulette_pvp_matches" (
  "id" serial PRIMARY KEY,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "stake_amount" numeric(10, 2) NOT NULL,
  "status" roulette_pvp_status NOT NULL DEFAULT 'waiting',
  "current_round" integer NOT NULL DEFAULT 1,
  "score_player1" integer NOT NULL DEFAULT 0,
  "score_player2" integer NOT NULL DEFAULT 0,
  "round_deadline" timestamp,
  "last_spin_result_index" integer,
  "last_spin_result" integer,
  "winner_id" varchar(255),
  "result" varchar(20),
  "house_fee" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "roulette_pvp_status_idx"
  ON "roulette_pvp_matches" ("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "roulette_pvp_player1_idx"
  ON "roulette_pvp_matches" ("player1_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "roulette_pvp_player2_idx"
  ON "roulette_pvp_matches" ("player2_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "roulette_pvp_stake_open_idx"
  ON "roulette_pvp_matches" ("stake_amount", "status");
--> statement-breakpoint

-- ── rounds ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "roulette_pvp_rounds" (
  "id" serial PRIMARY KEY,
  "match_id" integer NOT NULL REFERENCES "roulette_pvp_matches"("id") ON DELETE CASCADE,
  "round_number" integer NOT NULL,
  "is_sudden_death" boolean NOT NULL DEFAULT false,
  "spin_result_index" integer NOT NULL,
  "spin_result" integer NOT NULL,
  "player1_bets" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "player2_bets" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "player1_total_bet" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "player2_total_bet" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "player1_payout" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "player2_payout" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "player1_net" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "player2_net" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "round_winner" varchar(10),
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "roulette_pvp_rounds_match_round_idx"
  ON "roulette_pvp_rounds" ("match_id", "round_number");
