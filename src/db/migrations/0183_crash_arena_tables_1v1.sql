-- Migration 0183 — Crash Arena tables are 1v1.
--
-- The shared six-seat Crash Arena table mode was retired: every table is now a
-- head-to-head duel, so a table opens with exactly two seats (the host and one
-- opponent — a human, an invited player, or the AI bot). The application
-- already writes `max_players = 2` on every create/seed path (see
-- CRASH_ARENA_SEATS in src/lib/crash-poker/constants.js); this migration only
-- brings the column DEFAULT in line so an insert that omits the column can
-- never re-open a wider table.
--
-- No existing row is rewritten: an in-flight six-seat table keeps its capacity
-- so the players already seated in it can finish or disband normally.
--
-- Idempotent: safe to re-run, so it can also be pasted straight into the
-- Supabase SQL editor.

ALTER TABLE "crash_arena_tables"
  ALTER COLUMN "max_players" SET DEFAULT 2;

COMMENT ON COLUMN "crash_arena_tables"."max_players" IS
  'Table seats — Crash Arena is 1v1, so new tables open with 2';
