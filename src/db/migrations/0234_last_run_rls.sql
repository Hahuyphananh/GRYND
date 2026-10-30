-- 0234: Deny direct client access to the LAST RUN and match-lifecycle tables.
--
-- WHY THIS EXISTS
--   Supabase exposes `public` through PostgREST to the `anon` /
--   `authenticated` roles. Row Level Security was never enabled on
--   `match_lifecycle` or `match_lifecycle_events` (0104/0105 predate the RLS
--   work), and a table with RLS disabled is readable by any role that has been
--   granted SELECT on it.
--
--   These three tables are server-owned state:
--     * `last_run_matches`  — authoritative outcomes, distances, seeds;
--     * `match_lifecycle`   — every game's queue/match record;
--     * `match_lifecycle_events` — the settlement outbox (JSON payloads).
--
--   Nothing in the browser may read or write them: every access goes through
--   the Next.js server, which connects with the owner role over `pg`
--   (src/db/pool.ts). Realtime streaming is not used for any of the three.
--
-- DELIBERATELY NOT `FORCE ROW LEVEL SECURITY`
--   The application connects as the table owner, and FORCE would apply the
--   policies to the owner too — which would lock the app out of its own
--   settlement writes. This is the same documented choice as migration 0116.
--
-- Idempotent: ENABLE is a no-op when already enabled; DROP POLICY IF EXISTS +
-- CREATE POLICY is the safe re-run pattern (Postgres has no
-- `CREATE POLICY IF NOT EXISTS`).

ALTER TABLE "last_run_matches" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "last_run_matches_no_client_access" ON "last_run_matches";
CREATE POLICY "last_run_matches_no_client_access" ON "last_run_matches"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

ALTER TABLE "match_lifecycle" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "match_lifecycle_no_client_access" ON "match_lifecycle";
CREATE POLICY "match_lifecycle_no_client_access" ON "match_lifecycle"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

ALTER TABLE "match_lifecycle_events" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "match_lifecycle_events_no_client_access" ON "match_lifecycle_events";
CREATE POLICY "match_lifecycle_events_no_client_access" ON "match_lifecycle_events"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);
