-- src/db/migrations/0152_game_plays.sql
--
-- Per-game play counter powering the casino lobby's "Most Played" sort.
--
--   game_label   the gameLabel the game page passes to <CreatorModeHost />
--                (e.g. "plinko-duel", "chess-ai") — one row per label.
--   plays        lifetime count of real game sessions started (incremented
--                by /api/game-plays POST, fired from the same client-side
--                edge that records "Recently played" — a real session
--                start, never a page view).
--   last_played_at  last time a play was recorded (kept for analytics and
--                future "trending" sorts).
--
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS "game_plays" (
  "id" SERIAL PRIMARY KEY,
  "game_label" VARCHAR(64) NOT NULL UNIQUE,
  "plays" INTEGER NOT NULL DEFAULT 0,
  "last_played_at" TIMESTAMP
);