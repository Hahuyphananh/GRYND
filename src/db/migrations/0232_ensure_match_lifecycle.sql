-- 0232: Ensure the canonical match lifecycle tables exist on every database.
--
-- WHY THIS EXISTS
--   `0104_match_lifecycle` and `0105_match_lifecycle_events` are in the
--   migration-journal guard's LEGACY_UNJOURNALED list: their tables were
--   created on the live database by the Neon dump/restore, never by
--   `npm run db:migrate` (drizzle only walks `meta/_journal.json`).
--
--   That is fine for the current database, but it makes a FRESH database (a new
--   Supabase project, a staging clone, CI) silently incomplete: LAST RUN, and
--   every other game that mirrors its queue into `match_lifecycle`, would write
--   to tables that do not exist. Those writes are best-effort, so nothing
--   crashes — the results would just never be recorded.
--
--   This migration RE-DECLARES both tables and their indexes idempotently, and
--   is registered in the journal, so the chain can create them from scratch.
--   On the existing database every statement is a no-op.
--
-- Safe: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. No column is
-- altered, dropped or retyped, so existing rows and other games are untouched.

CREATE TABLE IF NOT EXISTS "match_lifecycle" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "match_id" varchar(255) NOT NULL UNIQUE,
  "game_key" varchar(80) NOT NULL,
  "mode" varchar(80) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'queued',
  "queued_at" timestamp NOT NULL DEFAULT NOW(),
  "started_at" timestamp,
  "ended_at" timestamp,
  "cancel_reason" varchar(40),
  "player_count" integer NOT NULL DEFAULT 0,
  "queue_wait_ms" integer,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  "updated_at" timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT "match_lifecycle_player_count_nonnegative" CHECK ("player_count" >= 0),
  CONSTRAINT "match_lifecycle_queue_wait_nonnegative" CHECK ("queue_wait_ms" IS NULL OR "queue_wait_ms" >= 0),
  CONSTRAINT "match_lifecycle_time_order" CHECK (
    ("started_at" IS NULL OR "started_at" >= "queued_at") AND
    ("ended_at" IS NULL OR "ended_at" >= "queued_at") AND
    ("ended_at" IS NULL OR "started_at" IS NULL OR "ended_at" >= "started_at")
  )
);

CREATE INDEX IF NOT EXISTS "match_lifecycle_status_queue_idx"
  ON "match_lifecycle" ("status", "queued_at");

CREATE INDEX IF NOT EXISTS "match_lifecycle_game_mode_idx"
  ON "match_lifecycle" ("game_key", "mode", "status");

CREATE TABLE IF NOT EXISTS "match_lifecycle_events" (
  "event_id" uuid PRIMARY KEY,
  "match_id" varchar(255) NOT NULL,
  "event_type" varchar(40) NOT NULL,
  "payload" jsonb NOT NULL,
  "occurred_at" timestamp NOT NULL DEFAULT NOW(),
  "published_at" timestamp,
  "attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT "match_lifecycle_events_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE INDEX IF NOT EXISTS "match_lifecycle_events_unpublished_idx"
  ON "match_lifecycle_events" ("published_at", "created_at");

CREATE INDEX IF NOT EXISTS "match_lifecycle_events_match_idx"
  ON "match_lifecycle_events" ("match_id", "created_at");
