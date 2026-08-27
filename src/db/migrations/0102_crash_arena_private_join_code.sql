-- Crash Arena — private table invite codes.
--
--   crash_arena_tables.join_code — a shonice,rt invite code for PRIVATE tables.
--   Joining a private table (other than the host or an existing member)
--   requires this code — the table URL alone no longer grants access, so
--   private games are invite-only (mirrors the poker private games, where
--   you join with the game code instead of the URL).
--
-- Public tables and AI practice tables leave it NULL (practice tables are
-- closed to joiners anyway). The code is stored uppercase, compared
-- case-insensitively on join, and returned only to the host.

ALTER TABLE "crash_arena_tables"
  ADD COLUMN IF NOT EXISTS "join_code" varchar(12);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_crash_arena_tables_join_code"
  ON "crash_arena_tables" ("join_code")
  WHERE "join_code" IS NOT NULL;
