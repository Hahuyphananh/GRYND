-- 0223_lane_rush_race_state.sql
--
-- LANE RUSH — persisted state for the strategic racing game.
--
-- The reworked Lane Rush (simultaneous planning, car tiers, routes, and the
-- Scrap/Fuel/Tech economy) is a versioned JSONB state machine, not a wall of
-- columns. Two ADDITIVE columns are enough to persist it safely:
--
--   game_state_version  integer NOT NULL DEFAULT 0
--   game_state          jsonb   NOT NULL DEFAULT '{}'::jsonb
--
-- WHY THE VERSION COLUMN: the table already holds glass-bridge duel rows. A
-- version of 0 (the default, and what every legacy row gets) means "not a
-- Lane Rush race", so an unfinished legacy match can never be interpreted as
-- new-game state — `readState()` in src/lib/lane-rush/engine.ts refuses it
-- explicitly. New rows write version 1 plus the engine's state object.
--
-- Nothing else changes: identity, match id, the player1/player2 seat model,
-- stake and settlement columns are reused, so matchmaking and payouts are
-- untouched by this migration. Additive and idempotent — safe to re-run and
-- safe to paste into the SQL editor.

ALTER TABLE "lane_rush_duel_matches"
  ADD COLUMN IF NOT EXISTS "game_state_version" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "game_state" jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN "lane_rush_duel_matches"."game_state_version" IS
  'Lane Rush race state version; 0 = legacy glass-bridge row (never read as a race)';

COMMENT ON COLUMN "lane_rush_duel_matches"."game_state" IS
  'Versioned Lane Rush race state (seats, cars, resources, results) — see src/lib/lane-rush/engine.ts';
