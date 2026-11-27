-- 0268: close `error_logs` to the public API roles.
--
-- WHAT WAS WRONG (2026-11 audit)
-- ------------------------------
-- 0094_rls_error_logs_policies.sql enabled RLS on `error_logs` and then added
-- two policies FOR the `anon` role: `error_logs_select_anon` (USING true) and
-- `error_logs_insert_anon`. Two consequences:
--
--   1. SELECT to `anon` USING (true) is a full read of every row — stack
--      traces, endpoints, metadata, device strings — for anyone holding the
--      publishable key that ships in the browser bundle. `anon` is PUBLIC, not
--      "the app".
--   2. The INSERT policy is invalid Postgres (`USING` is not allowed for
--      INSERT), so that statement fails; whether the migration applied at all
--      depended on how it was run. Either way the intent was wrong.
--
-- The app never needed either policy: both writers and readers use the
-- service-role key (src/lib/logError.ts, src/app/api/pm/errors/route.ts), and
-- service_role bypasses RLS. So the correct state is: RLS enabled, NO
-- policies, and no table grants for `anon` / `authenticated`.
--
-- This migration is idempotent: policies are dropped IF EXISTS, grants are
-- revoked only for roles that exist (a plain Postgres deployment has no
-- `anon`/`authenticated`/`service_role`, and this must still apply cleanly).

DO $$
BEGIN
  IF to_regclass('error_logs') IS NULL THEN
    RAISE NOTICE 'error_logs does not exist; nothing to lock down';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY';

  -- The two 0094 policies. Dropping them is the whole point: with RLS enabled
  -- and no permissive policy, the only reader is a role that bypasses RLS.
  EXECUTE 'DROP POLICY IF EXISTS error_logs_select_anon ON error_logs';
  EXECUTE 'DROP POLICY IF EXISTS error_logs_insert_anon ON error_logs';

  -- Belt and braces: even if a future policy is added by mistake, the API
  -- roles hold no table privilege to exercise it.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE error_logs FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE error_logs FROM authenticated';
  END IF;

  -- The server-side writer/reader. Harmless if it already holds everything.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL PRIVILEGES ON TABLE error_logs TO service_role';
  END IF;

  -- If the table has an id sequence, the service-role INSERT needs it too.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role';
  END IF;
END $$;

-- Verify after applying:
--   SELECT polname FROM pg_policy WHERE polrelid = 'error_logs'::regclass;
--     -- expect ZERO rows
--   SELECT has_table_privilege('anon', 'error_logs', 'SELECT');
--     -- expect false
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'error_logs'::regclass;
--     -- expect true
