-- 0250_audience_daily_snapshots.sql
--
-- ONE row per UTC day: the audience numbers an operator wants a trend for,
-- captured while they are still knowable.
--
-- WHY A TABLE
--   `user_presence` holds one row per user and is overwritten on every
--   heartbeat, and `users.last_played_game_date` only remembers the LATEST day
--   a player started a game. Neither can answer "what was peak concurrency
--   yesterday" or "how many people played last Tuesday" after the fact. This
--   table keeps the daily aggregate once, so the Operations dashboard can show
--   a trend instead of only "right now".
--
-- WHO WRITES IT
--   GET /api/jobs/audience-snapshot, scheduled every 15 minutes. Each run
--   UPSERTs today's row:
--     * peak_online  = GREATEST(stored, currently online)  — a high-water mark
--     * players      = users whose last_played_game_date is today
--     * signups      = users.created_at inside today (UTC)
--     * pro_members  = distinct active/trialing/past_due subscribers
--   Re-running it is free and safe; a missed run only means a slightly lower
--   peak for that day, never a wrong total.
--
-- RETENTION
--   One narrow row per day (~150 bytes), so there is nothing to prune: a year
--   is a few dozen kilobytes. No foreign keys — this is an aggregate, not a
--   per-user record, and it must survive account deletions.
--
-- RLS: default-deny, like the rest of the admin read path. Only the server
-- reads or writes it; nothing here is exposed to the browser or Realtime.
--
-- Idempotent + additive: CREATE TABLE IF NOT EXISTS, no drops, no backfill.

CREATE TABLE IF NOT EXISTS "audience_daily_snapshots" (
  "day" date PRIMARY KEY,
  "peak_online" integer NOT NULL DEFAULT 0 CHECK ("peak_online" >= 0),
  "players" integer NOT NULL DEFAULT 0 CHECK ("players" >= 0),
  "signups" integer NOT NULL DEFAULT 0 CHECK ("signups" >= 0),
  "pro_members" integer NOT NULL DEFAULT 0 CHECK ("pro_members" >= 0),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

ALTER TABLE "audience_daily_snapshots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audience_daily_snapshots_no_client_access" ON "audience_daily_snapshots";
CREATE POLICY "audience_daily_snapshots_no_client_access" ON "audience_daily_snapshots"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

COMMENT ON TABLE "audience_daily_snapshots" IS
  'One aggregate row per UTC day (peak online, players, signups, Pro members) written by the 15-minute audience-snapshot job';
COMMENT ON COLUMN "audience_daily_snapshots"."peak_online" IS
  'High-water mark of signed-in heartbeats within the 10-minute online window, sampled every 15 minutes';
COMMENT ON COLUMN "audience_daily_snapshots"."players" IS
  'Users whose last_played_game_date is this day (distinct players who started a game)';
COMMENT ON COLUMN "audience_daily_snapshots"."signups" IS
  'Accounts created during this UTC day';
COMMENT ON COLUMN "audience_daily_snapshots"."pro_members" IS
  'Distinct subscribers with an active, trialing or past_due status at the last sample of the day';
