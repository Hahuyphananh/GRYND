-- ── 0229: Hillstrike online PvP ─────────────────────────────────────────────
--
-- Hillstrike's online 1v1 match model, mirroring the proven turn-based PvP shape
-- (`barricade_matches` / `barricade_moves`, 0207):
--
--   * `hillstrike_matches` — ONE row per match. `game_state` is the single
--     authoritative frozen `HillstrikeState` the rules engine
--     (src/lib/hillstrike/rules.ts) produced; `ply` is the accepted-SHOT count
--     that doubles as the optimistic-concurrency version (`expectedVersion`),
--     and `player2_id` is NULL while the row is an open lobby (which is what
--     makes the listing and the matchmaking scan a single indexed predicate).
--   * `hillstrike_shots` — the append-only action log. The unique
--     (match_id, action_index) index is the STORAGE-level anti-replay
--     guarantee: the application checks the version inside a `FOR UPDATE`
--     transaction, and this index makes "one persisted shot per action index
--     per match" impossible to violate even if a future code path forgets it.
--
-- WHAT IS AUTHORITATIVE, AND WHERE
--
--   * `seed` + `field_version` + `initial_battlefield` — the layout the match was
--     dealt. The initial battlefield is stored alongside the seed so a replay (or
--     a dispute) can be checked against the ground the players actually saw, and
--     so a later generator retune cannot silently change a live match.
--   * `game_state` — the CURRENT authoritative state: whose turn it is, whether
--     the opening one-shot volley is still pending, shots remaining in the
--     volley, each seat's lives, the terrain, both towers and the last resolved
--     shot (with its trajectory, which is what both clients animate). Those
--     fields are deliberately NOT duplicated as columns: they have exactly one
--     writer (the store's shot transaction) and are read off the row's state, so
--     a duplicated column could only drift.
--   * `ply` — the version/turn index (accepted shots so far).
--   * `current_turn_user_id` — derived from `game_state.turn` on every accepted
--     shot, so the lobby and the routes can name the seat to move without
--     decoding the JSON.
--   * `result` / `winner_id` / `result_reason` — the terminal truth, written
--     exactly once by the transaction that claimed the match.
--
-- SECURITY / SCOPE NOTES
--
--   * NO money columns: no wager, stake, pot, payout, prize or token reference.
--     Hillstrike online is unstaked, so settlement moves no money — only Elo,
--     trophies and the account W/L counters.
--   * Player ids are plain Clerk-id strings with no FK to `users`, matching every
--     other PvP table.
--   * These tables are NOT added to the `supabase_realtime` publication. The live
--     channel for a match is the Socket.IO per-match room
--     (`hillstrike:match:<id>`), which is participant-guarded; publishing the
--     rows would stream both players' ids to anyone holding the public key for no
--     benefit (the board is always re-read from the authoritative snapshot).
--   * A client never writes here. The only player-authored values accepted by the
--     store are `{ angleDeg, power }` and `expectedVersion`; the board, the
--     collisions, the damage, the lives, the terrain, the winner and the
--     completion flag are all derived by the server's own engine.
--
-- Idempotent: safe to re-run (and safe to paste into the Supabase SQL editor),
-- like the other hand-written migrations in this folder.

CREATE TABLE IF NOT EXISTS "hillstrike_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "player1_id" varchar(255) NOT NULL,
  "player2_id" varchar(255),
  "winner_id" varchar(255),
  "current_turn_user_id" varchar(255),
  "ply" integer DEFAULT 0 NOT NULL,
  "status" varchar(20) DEFAULT 'waiting' NOT NULL,
  "seed" bigint NOT NULL,
  "field_version" integer NOT NULL,
  "opening_seat" varchar(8) NOT NULL,
  "initial_battlefield" jsonb NOT NULL,
  "game_state" jsonb NOT NULL,
  "result" varchar(20),
  "result_reason" varchar(24),
  "started_at" timestamp,
  "ended_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hillstrike_matches_status_idx"
  ON "hillstrike_matches" ("status", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hillstrike_matches_player1_idx"
  ON "hillstrike_matches" ("player1_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hillstrike_matches_player2_idx"
  ON "hillstrike_matches" ("player2_id", "created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "hillstrike_shots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "match_id" uuid NOT NULL REFERENCES "hillstrike_matches"("id") ON DELETE CASCADE,
  "action_index" integer NOT NULL,
  "player_id" varchar(255) NOT NULL,
  "seat" varchar(8) NOT NULL,
  "angle_deg" double precision NOT NULL,
  "power" integer NOT NULL,
  "impact_kind" varchar(16) NOT NULL,
  "impact_x" double precision NOT NULL,
  "impact_y" double precision NOT NULL,
  "target_seat" varchar(8),
  "lives_lost" integer DEFAULT 0 NOT NULL,
  "outcome" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "hillstrike_shots_match_idx"
  ON "hillstrike_shots" ("match_id", "action_index");
--> statement-breakpoint

-- Anti-replay: one persisted shot per action index per match. Two concurrent
-- requests for the same shot can never both commit — the loser gets a unique
-- violation, which the store reports as a clean 409.
CREATE UNIQUE INDEX IF NOT EXISTS "hillstrike_shots_action_unique"
  ON "hillstrike_shots" ("match_id", "action_index");
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_matches"."game_state" IS
  'Authoritative HillstrikeState (src/lib/hillstrike/rules.ts) — current seat (turn), opening-shot pending flag, shots remaining in the volley, turn index, both lives, terrain, both towers and the last resolved shot.';
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_matches"."ply" IS
  'Accepted shots so far; the optimistic-concurrency version the shot route checks (expectedVersion) and the action index the next shot claims.';
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_matches"."initial_battlefield" IS
  'The layout generated from `seed` at match creation, kept so a stored match still replays against the ground the players saw.';
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_matches"."result_reason" IS
  'lives-exhausted | resigned | abandoned (END_REASONS). NULL while the match is live.';
--> statement-breakpoint

COMMENT ON COLUMN "hillstrike_shots"."outcome" IS
  'The server-resolved outcome of the shot: impact, lives lost, lives after, the new turn/volley counters and any terminal status.';
