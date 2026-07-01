-- ── Blackjack PvP match system ────────────────────────────────────────
-- Best-of-3 simultaneous blackjack between two real players.
-- Follows the same conventions as roulette_pvp_matches:
--   * clerkIds stored as varchar(255) (no FK to `users`)
--   * stake/financials as numeric(10, 2)
--   * pgEnum for status keeps the state machine strongly typed
--   * `blackjack_pvp_rounds` cascades from `blackjack_pvp_matches`
--
-- Match flow:
--   waiting → ready → round_1 → round_2 → round_3 → finished
--
-- Per-round flow (state machine):
--   Both players are dealt 2 starting cards.
--   Each player independently hits or stands. A round resolves when
--   BOTH players have reached a terminal per-round state:
--     * stood  ─ explicit "Rester" by the player
--     * busted ─ the latest hit pushed their hand over 21
--   If `round_deadline` elapses, any player still in `playing` is
--   force-marked `stood` so the round can resolve.
--
-- Round winner: closer to 21 without busting.
--   * Both bust  → draw (round_winner: 'draw')
--   * One busts  → other player wins (still resolution requires the
--                  other to be in {stood,busted} too — their hand
--                  finalises against the busted opponent's "bust > 21"
--                  score automatically since bust-hand scores as ∞ and
--                  loses to any non-bust 0..21 score).
--   * Same score → draw
-- Round wins increment `score_player1` / `score_player2` by 1 for the
-- winner; draws leave both scores untouched.
--
-- Match resolution:
--   * Match ends EARLY the moment one player reaches score_player = 2.
--   * Otherwise match ends after round_3 resolves.
--   * If scores are tied after round_3 → match result is `draw` and
--     BOTH players are refunded their full stake (no house fee).
--   * Otherwise the winner takes the pot minus a 2.5% house fee.

-- ── enums ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'blackjack_pvp_status') THEN
    CREATE TYPE blackjack_pvp_status AS ENUM (
      'waiting',
      'ready',
      'round_1',
      'round_2',
      'round_3',
      'finished',
      'cancelled'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'blackjack_pvp_player_state') THEN
    CREATE TYPE blackjack_pvp_player_state AS ENUM (
      'playing',
      'stood',
      'busted'
    );
  END IF;
END
$$;
--> statement-breakpoint

-- ── matches ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "blackjack_pvp_matches" (
  "id" serial PRIMARY KEY,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "stake_amount" numeric(10, 2) NOT NULL,
  "status" blackjack_pvp_status NOT NULL DEFAULT 'waiting',
  "current_round" integer NOT NULL DEFAULT 1,
  "score_player1" integer NOT NULL DEFAULT 0,
  "score_player2" integer NOT NULL DEFAULT 0,

  -- Live per-round transient state. Both hands are stored server-side
  -- in JSONB. The match-state route scrubs the OPPONENT's hand before
  -- returning so cards stay hidden until the round resolves.
  "player1_hand" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "player2_hand" jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Per-seat round action state. `playing` means the player may still
  -- hit/stand this round. `stood` is an explicit Rester. `busted` is
  -- the latest hit pushed hand value > 21.
  "player1_state" blackjack_pvp_player_state NOT NULL DEFAULT 'playing',
  "player2_state" blackjack_pvp_player_state NOT NULL DEFAULT 'playing',

  -- Server-authoritative shoe. Pops from the front so `player1_hand[0]`
  -- was the card dealt first and `deck[0]` is the next available card.
  "deck" jsonb NOT NULL DEFAULT '[]'::jsonb,

  "round_deadline" timestamp,

  -- Final match bookkeeping
  "winner_id" varchar(255),
  "result" varchar(20), -- 'player1' | 'player2' | 'draw' | null
  "house_fee" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0.00',

  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "blackjack_pvp_status_idx"
  ON "blackjack_pvp_matches" ("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "blackjack_pvp_player1_idx"
  ON "blackjack_pvp_matches" ("player1_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "blackjack_pvp_player2_idx"
  ON "blackjack_pvp_matches" ("player2_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "blackjack_pvp_stake_open_idx"
  ON "blackjack_pvp_matches" ("stake_amount", "status");
--> statement-breakpoint

-- ── rounds ─────────────────────────────────────────────────────────────
-- Per-round final snapshots for replay/history. Cascade-deleted with
-- the parent match. round_winner is null when the round ended in a
-- draw (no points awarded).
CREATE TABLE IF NOT EXISTS "blackjack_pvp_rounds" (
  "id" serial PRIMARY KEY,
  "match_id" integer NOT NULL REFERENCES "blackjack_pvp_matches"("id") ON DELETE CASCADE,
  "round_number" integer NOT NULL,
  "player1_hand" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "player2_hand" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "player1_score" integer NOT NULL,
  "player2_score" integer NOT NULL,
  "player1_state" blackjack_pvp_player_state NOT NULL,
  "player2_state" blackjack_pvp_player_state NOT NULL,
  "round_winner" varchar(10), -- 'player1' | 'player2' | 'draw' | null
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "blackjack_pvp_rounds_match_round_idx"
  ON "blackjack_pvp_rounds" ("match_id", "round_number");
