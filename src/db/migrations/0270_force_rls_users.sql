-- 0270: FORCE Row Level Security on `users`.
--
-- WHAT FORCE ADDS
-- ---------------
-- 0269 turned RLS on for `users` and gave it no policies, which denies every
-- role except the table OWNER — and the owner bypasses RLS by default. FORCE
-- removes that exemption, so the owner is subject to the policies too. That
-- matters while any process still connects as the owner: it is what stops the
-- owner path from being the quiet way around the boundary.
--
-- THE POLICY THIS ADDS, AND WHY
-- -----------------------------
-- Dropping the owner exemption without a policy would break every legitimate
-- owner-side read: `pg_dump` (backups), the purge/backfill scripts, and any
-- migration-time data fix. A silent, truncated backup is worse than no RLS at
-- all, so the owner gets an explicit policy — resolved from `pg_class.relowner`
-- at apply time, because the owner is `postgres` on Supabase but may be
-- anything on another host.
--
-- This policy is deliberately NOT `TO PUBLIC`: `anon` and `authenticated` stay
-- with no policy and no grant (0269 revoked them), so they see nothing.
--
-- The app role (`app_user`) is not the owner and is therefore unaffected by
-- this migration; it reads `users` through the policy created by
-- docs/security-fixes/staging-app-role.sql. Applying this before or after that
-- cutover is safe either way.
--
-- Reversible:
--   ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
--   DROP POLICY IF EXISTS users_owner_all ON users;

DO $$
DECLARE
  owner_name text;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE 'users does not exist; nothing to force';
    RETURN;
  END IF;

  SELECT r.rolname
    INTO owner_name
    FROM pg_class c
    JOIN pg_roles r ON r.oid = c.relowner
   WHERE c.oid = 'public.users'::regclass;

  IF owner_name IS NULL THEN
    RAISE EXCEPTION 'could not resolve the owner of users; refusing to FORCE RLS without an owner policy';
  END IF;

  -- The owner keeps full access it already had; the difference is that the
  -- exemption is now an explicit, auditable policy instead of an implicit one.
  EXECUTE 'DROP POLICY IF EXISTS users_owner_all ON public.users';
  EXECUTE format(
    'CREATE POLICY users_owner_all ON public.users FOR ALL TO %I USING (true) WITH CHECK (true)',
    owner_name
  );

  EXECUTE 'ALTER TABLE public.users ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.users FORCE ROW LEVEL SECURITY';
END $$;

-- Verify after applying:
--   SELECT relrowsecurity, relforcerowsecurity
--     FROM pg_class WHERE oid = 'public.users'::regclass;
--     -- expect true, true
--   SELECT policyname, roles FROM pg_policies WHERE tablename = 'users';
--     -- expect users_owner_all -> {<owner>} and, after the app-role cutover,
--     --        app_user_all -> {app_user}. Never {public}.
--   -- Backup sanity check (must return the real row count, not 0):
--   SELECT count(*) FROM users;
