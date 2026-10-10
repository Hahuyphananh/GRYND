-- ── 0207: Barricade online PvP ───────────────────────────────────────────────
--
-- Barricade's online 1v1 match model. Two tables, mirroring the proven
-- turn-based PvP shape (see `tic_tac_toe_matches` / `tic_tac_toe_moves`, 0192):
--
--   * `barricade_matches` — ONE row per match; `game_state` is the single
--     authoritative frozen `BarricadeState` the rules engine
--     (src/lib/barricade/rules.ts) produced, `ply` is the accepted-action count
--     that doubles as the optimistic-concurrency version, and `player2_id` is
--     NULL while the row is an open lobby (that is what makes the listing and
--     the matchmaking scan a single indexed predicate).
--   * `barricade_moves` — the append-only replay log. The unique
--     (match_id, ply) index is the STORAGE-level anti-replay guarantee: the
--     application checks the version inside a `FOR UPDATE` transaction, and this
--     index makes "one persisted action per turn number per match" impossible to
--     violate even if a future code path forgets that check.
--
-- SECURITY / SCOPE NOTES
--
--   * NO money columns: no wager, stake, pot, payout, prize or token reference.
--     The game is unstaked, so settlement moves no money.
--   * Player ids are plain Clerk-id strings with no FK to `users`, matching
--     every other PvP table.
--   * These tables are NOT added to the `supabase_realtime` publication. The
--     live channel for a match is the Socket.IO per-match room
--     (`barricade:match:<id>`), which is participant-guarded; publishing the
--     rows would stream both players' ids to anyone holding the public key for
--     no benefit (the board is always re-read from the authoritative snapshot).
--
-- Idempotent: safe to re-run (and safe to paste into the Supabase SQL editor),
-- like the other hand-written migrations in this folder.

CREATE TABLE IF NOT EXISTS "barricade_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "winner_id" varchar(255),
  "current_turn_user_id" varchar(255),
  "ply" integer DEFAULT 0 NOT NULL,
  "status" varchar(20) DEFAULT 'waiting' NOT NULL,
  "game_state" jsonb NOT NULL,
  "result" varchar(20),
  "result_reason" varchar(24),
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "barricade_matches_status_idx"
  ON "barricade_matches" ("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "barricade_matches_player1_idx"
  ON "barricade_matches" ("player1_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "barricade_matches_player2_idx"
  ON "barricade_matches" ("player2_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "barricade_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "match_id" uuid NOT NULL REFERENCES "barricade_matches"("id") ON DELETE CASCADE,
  "ply" integer NOT NULL,
  "player_id" varchar(255) NOT NULL,
  "action_type" varchar(12) NOT NULL,
  "col" integer NOT NULL,
  "row" integer NOT NULL,
  "orientation" varchar(12),
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "barricade_moves_match_idx"
  ON "barricade_moves" ("match_id", "ply");
--> statement-breakpoint

-- Anti-replay: one persisted action per turn number per match. Two concurrent
-- requests for the same turn can never both commit — the loser gets a unique
-- violation, which the store reports as a clean 409.
CREATE UNIQUE INDEX IF NOT EXISTS "barricade_moves_ply_unique"
  ON "barricade_moves" ("match_id", "ply");
--> statement-breakpoint

COMMENT ON COLUMN "barricade_matches"."game_state" IS
  'Authoritative BarricadeState (src/lib/barricade/rules.ts) — the frozen position the rules engine produced.';
--> statement-breakpoint

COMMENT ON COLUMN "barricade_matches"."ply" IS
  'Accepted actions so far; the optimistic-concurrency version the move route checks (expectedVersion).';
--> statement-breakpoint

COMMENT ON COLUMN "barricade_matches"."result_reason" IS
  'reached-baseline | resigned | abandoned | cancelled (END_REASONS). NULL while the match is live.';
