-- 0058_add_player_reports_columns.sql
-- Heal stale `player_reports` tables that predate the report columns.
--
-- Background: migration `0030_add_player_reports.sql` (and the runtime
-- self-heal in src/lib/reports/submitReport.ts) only ever ran
-- `CREATE TABLE IF NOT EXISTS`, which is a no-op on an existing table.
-- Environments whose table was created before `game_type` existed keep a
-- column set that makes every report dedupe / INSERT fail with Postgres
-- "column \"game_type\" does not exist" (a 500 on POST /api/reports/submit
-- and on the admin reports API).
--
-- This migration converges any pre-existing table to the exact schema
-- declared in src/db/schema.ts (`playerReports`), column by column.
--
-- Applied manually like the other raw SQL migrations (0055+ are not in
-- the drizzle journal). Every statement is idempotent:
--   • `ADD COLUMN IF NOT EXISTS` no-ops on columns that already exist
--     (e.g. after the runtime self-heal already ran)
--   • NOT NULL columns are backfilled via a temporary DEFAULT which is
--     then dropped so the live schema matches schema.ts exactly
--   • `DROP DEFAULT` on a column without a default is a no-op
--
-- Standalone: the CREATE guard below also covers environments that never
-- created the table at all (neither 0030 nor the runtime self-heal ran),
-- so this migration is safe to apply on any database.
--
-- Note: the runtime self-heal (src/lib/reports/submitReport.ts) adds the
-- same columns but leaves the temporary DEFAULTs in place; this migration
-- drops them to match schema.ts. Both paths work — every INSERT supplies
-- explicit values — the only difference is the column DEFAULT state.

-- Guard: create the table (complete column set) if it doesn't exist yet.
CREATE TABLE IF NOT EXISTS player_reports (
  id SERIAL PRIMARY KEY,
  reporter_clerk_id VARCHAR(255) NOT NULL,
  reported_clerk_id VARCHAR(255) NOT NULL,
  game_type VARCHAR(50) NOT NULL,
  game_id VARCHAR(100),
  reason VARCHAR(50) NOT NULL,
  details TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP,
  resolved_by_clerk_id VARCHAR(255)
);

-- reporter / reported / game_type / reason are NOT NULL with NO default
-- in the schema — add with a backfill default, then remove it.
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS reporter_clerk_id VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE player_reports ALTER COLUMN reporter_clerk_id DROP DEFAULT;

ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS reported_clerk_id VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE player_reports ALTER COLUMN reported_clerk_id DROP DEFAULT;

ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS game_type VARCHAR(50) NOT NULL DEFAULT '';
ALTER TABLE player_reports ALTER COLUMN game_type DROP DEFAULT;

ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS reason VARCHAR(50) NOT NULL DEFAULT '';
ALTER TABLE player_reports ALTER COLUMN reason DROP DEFAULT;

-- Nullable columns — no default needed.
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS game_id VARCHAR(100);
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS details TEXT;
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS resolved_by_clerk_id VARCHAR(255);

-- status / created_at carry defaults in the schema — keep them.
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE player_reports ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();

-- Report lookup indexes (kept in sync with migration 0030).
CREATE INDEX IF NOT EXISTS idx_player_reports_status ON player_reports (status, created_at);
CREATE INDEX IF NOT EXISTS idx_player_reports_reported ON player_reports (reported_clerk_id);
