-- Crash Poker — configurable blinds + all-in support.
--
--   crash_arena_tables.small_blind  — per-table Small Blind override. NULL
--                                     (the default) means the standard ratio
--                                     applies: round(wager / 2). Persisted at
--                                     table creation so each table's blinds
--                                     are configurable without code changes.
--   crash_arena_entries.all_in      — player committed their entire remaining
--                                     stack to the pot; they can no longer
--                                     act at later checkpoints and count as
--                                     matched when the checkpoint resolves.
--
-- Both columns are additive (ADD COLUMN IF NOT EXISTS), safe to run on an
-- environment one migration behind — mirroring 0098.

ALTER TABLE "crash_arena_tables"
  ADD COLUMN IF NOT EXISTS "small_blind" numeric(10, 2);

ALTER TABLE "crash_arena_entries"
  ADD COLUMN IF NOT EXISTS "all_in" boolean NOT NULL DEFAULT false;
