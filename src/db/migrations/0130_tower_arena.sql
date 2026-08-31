-- Seed for Tower Arena: 2-6 player shared-tower stacking game.
-- Server-authoritative state lives in jsonb columns; seats are
-- normalized into tower_arena_players (no fixed player seats).
BEGIN;

CREATE TABLE IF NOT EXISTS "tower_arena_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "status" varchar(20) NOT NULL DEFAULT 'waiting',
  "wager" integer NOT NULL,
  "max_players" integer NOT NULL,
  "host_user_id" varchar(255) NOT NULL,
  "is_ai" boolean NOT NULL DEFAULT false,
  "phase" varchar(20) NOT NULL DEFAULT 'waiting',
  "resource_cycle" integer NOT NULL DEFAULT 0,
  "turn_number" integer NOT NULL DEFAULT 0,
  "current_turn_player_id" varchar(255),
  "turn_deadline" timestamptz,
  "resource_pool" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "tower_state" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reserve_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "placements" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "final_rankings" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "winner_id" varchar(255),
  "prize_pool" integer NOT NULL DEFAULT 0,
  "house_fee" integer NOT NULL DEFAULT 0,
  "pot" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "ended_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "tower_arena_players" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "match_id" uuid NOT NULL REFERENCES "tower_arena_matches"("id") ON DELETE CASCADE,
  "user_id" varchar(255) NOT NULL,
  "seat" integer NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "placement" integer,
  "is_ai" boolean NOT NULL DEFAULT false,
  "reserve_uses_remaining" integer NOT NULL DEFAULT 2,
  "reserved_block" jsonb,
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "eliminated_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "tower_arena_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "match_id" uuid NOT NULL REFERENCES "tower_arena_matches"("id") ON DELETE CASCADE,
  "user_id" varchar(255) NOT NULL,
  "seat" integer NOT NULL,
  "turn_number" integer NOT NULL,
  "resource_cycle" integer NOT NULL,
  "phase" varchar(20) NOT NULL,
  "action_type" varchar(20) NOT NULL,
  "block_shape" varchar(30),
  "position_x" integer,
  "rotation" integer,
  "block_id" varchar(40),
  "collapsed" boolean NOT NULL DEFAULT false,
  "tower_delta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "tower_arena_matches_status_idx" ON "tower_arena_matches"("status", "created_at");
CREATE INDEX IF NOT EXISTS "tower_arena_matches_user_idx" ON "tower_arena_matches"("host_user_id");
CREATE INDEX IF NOT EXISTS "tower_arena_players_match_idx" ON "tower_arena_players"("match_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tower_arena_players_match_seat_unique" ON "tower_arena_players"("match_id", "seat");
CREATE INDEX IF NOT EXISTS "tower_arena_turns_match_idx" ON "tower_arena_turns"("match_id");

COMMIT;