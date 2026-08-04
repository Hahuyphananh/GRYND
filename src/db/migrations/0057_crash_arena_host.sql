-- 0057_crash_arena_host.sql
-- Add host/owner attribution to crash arena tables.
-- The creator of a table is stored as host_id (users.id). System-seeded
-- default tables keep host_id NULL. Deleting a user leaves the table in
-- place and resets the host to NULL (players already cascade separately).

ALTER TABLE "crash_arena_tables"
  ADD COLUMN "host_id" integer REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX "idx_crash_arena_tables_host"
  ON "crash_arena_tables" ("host_id", "status", "created_at");
