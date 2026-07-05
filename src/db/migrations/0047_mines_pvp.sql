-- ── Mines PvP match system ─────────────────────────────────────────
-- Two-player real-time "Mines Duel". Both players on the same 5×5
-- board; the HOST picks the mine count at lobby creation. The
-- server randomizes turn order at match creation (when player2
-- joins), then each player gets a 20s window to pick a single
-- cell. The match resolves after both picks.
--
-- Schema conventions match roulette_pvp_matches /
-- blackjack_pvp_matches:
--   * clerkIds stored as varchar(255), no FK to `users`
--   * stake/financials as numeric(10, 2)
--   * pgEnum for `status` keeps the 6 match states strongly typed
--   * `mines_pvp_rounds` cascades from `mines_pvp_matches`
--
-- Resolution rules (per user spec):
--   P1 mine + P2 mine → P2 loses (P1 mined first)
--   P1 mine + P2 safe → P1 loses
--   P1 safe + P2 mine → P2 loses
--   P1 safe + P2 safe → DRAW (full refund, no house fee)
--
-- Payout:
--   Winner: own stake back + 90% of loser's stake
--   Loser:   loses entire stake
--   House:   10% rake on loser's stake only
--   Draw:    both refunded, no rake

-- ── enum ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mines_pvp_status') THEN
    CREATE TYPE mines_pvp_status AS ENUM (
      'waiting',
      'ready',
      'p1_turn',
      'p2_turn',
      'finished',
      'cancelled'
    );
  END IF;
END
$$;
--> statement-breakpoint

-- ── matches ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "mines_pvp_matches" (
  "id" serial PRIMARY KEY,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "stake_amount" numeric(10, 2) NOT NULL,
  "status" mines_pvp_status NOT NULL DEFAULT 'waiting',
  -- Host-chosen mine count at lobby creation (1-24, since 25 would
  -- be 100% mines and an instant loss for every pick).
  "mines_count" integer NOT NULL,
  -- 5×5 board — SERVER-ONLY state. Shape:
  --   { "size": 5, "mines": [3, 7, 12] }
  -- where mines.length === mines_count and each entry is a unique
  -- 0-24 row-major cell index. Scrubbed from /status responses
  -- while the match is in {waiting, ready, p1_turn, p2_turn} and
  -- exposed to both clients once status='finished'.
  "board" jsonb NOT NULL DEFAULT '{"size":5,"mines":[]}'::jsonb,
  -- Server-decided at match creation (when player2 joins). Either
  -- equals player1_id or player2_id. Null until both players have
  -- joined.
  "first_player_id" varchar(255),
  -- clerkId of the player currently being asked to pick. Null when
  -- status is in {waiting, ready, finished, cancelled}.
  "current_turn_user_id" varchar(255),
  -- 0-24 row-major cell index the player picked. Null until the
  -- player picks (or gets auto-picked at deadline).
  "p1_pick" integer,
  "p2_pick" integer,
  -- Whether the player's pick landed on a mine. Computed at pick
  -- time and persisted so post-match replays don't have to walk
  -- `board` to render the result.
  "p1_pick_is_mine" boolean,
  "p2_pick_is_mine" boolean,
  -- True when the server auto-picked because round_deadline
  -- elapsed before the player acted. Persisted for history /
  -- replay so spectators can see when a player went AFK.
  "p1_auto_picked" boolean NOT NULL DEFAULT false,
  "p2_auto_picked" boolean NOT NULL DEFAULT false,
  "p1_picked_at" timestamp,
  "p2_picked_at" timestamp,
  -- Pick-window deadline. 20s per spec. The server's
  -- `fetchMatchWithAutoResolve` mirrors blackjack-pvp /
  -- roulette-pvp: when this timestamp elapses and the active
  -- player hasn't picked, auto-pick a random cell.
  "round_deadline" timestamp,
  -- 20 seconds default per spec. Stored on the row for parity with
  -- roulette-pvp.round_timer_seconds and admin-tweakable without
  -- code changes.
  "round_timer_seconds" integer NOT NULL DEFAULT 20,
  -- Final match bookkeeping.
  "winner_id" varchar(255),
  "result" varchar(20), -- 'player1' | 'player2' | 'draw' | null
  "house_fee" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "prize_paid" numeric(10, 2) NOT NULL DEFAULT '0.00',
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mines_pvp_status_idx"
  ON "mines_pvp_matches" ("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mines_pvp_player1_idx"
  ON "mines_pvp_matches" ("player1_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mines_pvp_player2_idx"
  ON "mines_pvp_matches" ("player2_id", "created_at");
--> statement-breakpoint

-- Stake matchmaking — finding a waiting lobby whose stake matches
-- the joiner's request. `stake + status='waiting' + player2 IS
-- NULL` is the canonical "join any open match of this stake"
-- query.
CREATE INDEX IF NOT EXISTS "mines_pvp_stake_open_idx"
  ON "mines_pvp_matches" ("stake_amount", "status");
--> statement-breakpoint

-- Open-lobby partial index — backs the
-- `WHERE status='waiting' AND player2_id IS NULL ORDER BY created_at DESC`
-- query that the lobby page runs on every render. A partial index
-- constrained to those rows keeps the index tiny (one entry per
-- open lobby) and lets Postgres answer the lobby listing in a
-- single index scan in DESC order, even once the historical-match
-- table grows. Indexed DESC explicitly to match the ORDER BY so
-- Postgres can skip a sort step.
CREATE INDEX IF NOT EXISTS "mines_pvp_open_lobbies_idx"
  ON "mines_pvp_matches" ("created_at" DESC)
  WHERE "status" = 'waiting' AND "player2_id" IS NULL;
--> statement-breakpoint

-- ── rounds ───────────────────────────────────────────────────────
-- Per-match final snapshot. Cascade-deleted with the parent match.
-- `round_winner` mirrors match.result for parity with the other
-- PvP systems (e.g., coin_flip best-of-3 also persists
-- `round_winner` even though it only ever has one row per match).
CREATE TABLE IF NOT EXISTS "mines_pvp_rounds" (
  "id" serial PRIMARY KEY,
  "match_id" integer NOT NULL REFERENCES "mines_pvp_matches"("id") ON DELETE CASCADE,
  "round_number" integer NOT NULL DEFAULT 1,
  "p1_pick" integer,
  "p2_pick" integer,
  "p1_pick_is_mine" boolean,
  "p2_pick_is_mine" boolean,
  "p1_auto_picked" boolean NOT NULL DEFAULT false,
  "p2_auto_picked" boolean NOT NULL DEFAULT false,
  -- Final board state snapshotted at resolution so post-match
  -- replays can render the full mine layout without walking the
  -- live match row.
  "board_snapshot" jsonb NOT NULL DEFAULT '{"size":5,"mines":[]}'::jsonb,
  -- 'player1' | 'player2' | 'draw' | null
  "round_winner" varchar(10),
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "mines_pvp_rounds_match_round_idx"
  ON "mines_pvp_rounds" ("match_id", "round_number");
