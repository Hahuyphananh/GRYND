-- 0243_guest_and_platform_rls.sql
--
-- PHASE 6 AUDIT FIX — default-deny RLS on the tables introduced in Phases 1-5.
--
-- WHY THIS EXISTS
--   Supabase exposes `public` through PostgREST to the `anon` and
--   `authenticated` roles. The Phase 1-5 migrations (0239 guest_profiles,
--   0240 guest_practice_results, 0241 guest_claims, 0242 platform_sessions)
--   created their tables WITHOUT enabling Row Level Security. This is exactly
--   the gap migration 0234 closed for last_run / match_lifecycle: a table with
--   RLS disabled is readable and writable by any role that holds a grant.
--
--   The exposed data is server-owned:
--     * guest_profiles           - guest identities and activity timestamps;
--     * guest_practice_results   - one row per settled anonymous practice game;
--     * guest_claims             - which account claimed which guest record;
--     * platform_sessions        - platform metadata and SHA-256 session hashes.
--
--   None of it is needed by the browser: every read and write goes through the
--   Next.js server, which connects as the table owner over `pg`
--   (src/db/pool.ts) and therefore bypasses RLS. Realtime does not publish any
--   of these tables.
--
-- DELIBERATELY NOT `FORCE ROW LEVEL SECURITY`
--   FORCE would also apply these policies to the owning connection and lock the
--   app out of its own writes. Same documented choice as migrations 0116/0234.
--
-- Idempotent: ENABLE is a no-op when already enabled, and DROP POLICY IF EXISTS
-- + CREATE POLICY is the safe re-run pattern (Postgres has no
-- CREATE POLICY IF NOT EXISTS). Additive only: no table, column or index is
-- dropped, and no data is rewritten.

ALTER TABLE "guest_profiles" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "guest_profiles_no_client_access" ON "guest_profiles";
CREATE POLICY "guest_profiles_no_client_access" ON "guest_profiles"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

ALTER TABLE "guest_practice_results" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "guest_practice_results_no_client_access" ON "guest_practice_results";
CREATE POLICY "guest_practice_results_no_client_access" ON "guest_practice_results"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

ALTER TABLE "guest_claims" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "guest_claims_no_client_access" ON "guest_claims";
CREATE POLICY "guest_claims_no_client_access" ON "guest_claims"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

ALTER TABLE "platform_sessions" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_sessions_no_client_access" ON "platform_sessions";
CREATE POLICY "platform_sessions_no_client_access" ON "platform_sessions"
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- Block any PUBLIC grants that would have exposed these to a client role.
REVOKE ALL ON "guest_profiles"         FROM PUBLIC;
REVOKE ALL ON "guest_practice_results" FROM PUBLIC;
REVOKE ALL ON "guest_claims"           FROM PUBLIC;
REVOKE ALL ON "platform_sessions"      FROM PUBLIC;

-- The serial sequence is a separate relation; a PUBLIC USAGE grant would let a
-- client burn ids even with the table locked down.
REVOKE ALL ON SEQUENCE "guest_practice_results_id_seq" FROM PUBLIC;
