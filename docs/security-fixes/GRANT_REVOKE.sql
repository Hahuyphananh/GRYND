-- ============================================================================
-- GRANT / REVOKE migration — lock down the Supabase Data API surface
-- ============================================================================
--
-- This app authenticates with Clerk, not Supabase Auth. It talks to Postgres
-- exclusively through a server-side `pg` pool (src/db/pool.ts) using the
-- `postgres` owner role — the Supabase Data API (PostgREST) is never used,
-- and `@supabase/supabase-js` is not imported anywhere in src/.
--
-- Supabase exposes every table to the Data API through two built-in roles:
--   * anon        — used for unauthenticated Data API requests
--   * authenticated — used when a Supabase JWT is presented
-- Those roles have default GRANTs on the `public` schema, so if the Data API
-- were ever enabled (or a stray key leaked), tables would be readable —
-- REGARDLESS of RLS, because these roles do NOT own the tables and RLS is
-- currently enabled WITHOUT FORCE (owners bypass it; see RLS_MIGRATION.sql).
--
-- This migration REMOVES those default grants so the Data API can't expose
-- anything even if it is enabled. The app is unaffected: it connects as the
-- owner role, which holds its own privileges independently of these roles.
--
-- ⚠️ Review before applying (staging first). To undo, re-run the Supabase
-- default grants for the public schema (Supabase dashboard re-applies them
-- on "Restore defaults" for each table).
-- ============================================================================

-- ── 1. Public schema usage (prevents any new table from auto-granting) ──
REVOKE USAGE ON SCHEMA public FROM anon;
REVOKE USAGE ON SCHEMA public FROM authenticated;

-- ── 2. All existing tables + sequences ──
DO $$
DECLARE
  t text;
  s text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM authenticated', t);
  END LOOP;

  FOR s IN
    SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM anon', s);
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM authenticated', s);
  END LOOP;
END $$;

-- ── 3. Default privileges for FUTURE tables (defense in depth) ──
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;

-- ── 4. Functions (any SECURITY DEFINER helpers must not be callable) ──
DO $$
DECLARE
  f oid;
BEGIN
  FOR f IN
    SELECT p.oid FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f::regprocedure);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f::regprocedure);
  END LOOP;
END $$;
