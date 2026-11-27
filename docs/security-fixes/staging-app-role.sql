-- STAGING CUTOVER: the app stops connecting as the table OWNER.
--
-- WHY THIS IS A SCRIPT AND NOT A DRIZZLE MIGRATION
-- -----------------------------------------------
-- It creates a LOGIN role and a password, grants privileges on every existing
-- object, and expects you to change a connection string. That is a deploy
-- action with a blast radius (every query runs as a different role), so it is
-- applied deliberately, once, on staging, and verified before production.
-- 0270_force_rls_users.sql is the companion schema migration and is journaled.
--
-- RUN AS THE OWNER (the role that owns the tables — `postgres` on Supabase):
--
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 \
--        -f docs/security-fixes/staging-app-role.sql
--
-- THEN, out of band (never in this file, never in git):
--
--   psql "$OWNER_DATABASE_URL" -c "\password app_user"
--
-- THEN point the app at it and redeploy:
--
--   DATABASE_URL=postgresql://app_user:<password>@<host>:5432/<db>
--   MIGRATION_DATABASE_URL=postgresql://postgres:<password>@<host>:5432/<db>
--
-- `MIGRATION_DATABASE_URL` is what `npm run db:migrate` uses (src/db/migrate.ts),
-- so DDL keeps running as the owner while the app runs as app_user. Without it,
-- migrations fall back to DATABASE_URL and would fail as app_user — which is
-- the intended fail-closed direction.
--
-- WHAT THIS DOES NOT DO: it does not set FORCE ROW LEVEL SECURITY (that is
-- 0270's job) and it does not drop the owner's own access.

\set ON_ERROR_STOP on

-- ── 0. Where am I? ──────────────────────────────────────────────────────
SELECT current_user AS applying_as, current_database() AS database,
       current_setting('server_version') AS server_version;

-- ── 1. The role ─────────────────────────────────────────────────────────
-- NOBYPASSRLS is the entire point: this role is subject to every policy.
-- LOGIN, but no CREATEDB/CREATEROLE, and no membership inheritance, so a
-- future GRANT of a privileged role cannot silently lift its rights.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user
      LOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      CONNECTION LIMIT 20;
  END IF;
END $$;

-- Deterministic name resolution: the app never resolves an object through a
-- schema it does not own.
ALTER ROLE app_user SET search_path TO public;

-- ── 2. Connect and schema ───────────────────────────────────────────────
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_user', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
-- Read, never create: the app must not be able to add objects to public.
REVOKE CREATE ON SCHEMA public FROM app_user;

-- ── 3. Existing objects ─────────────────────────────────────────────────
-- DML only. No TRUNCATE, no REFERENCES, no TRIGGER — the app needs none of
-- them, and each one is a way to destroy or reshape data.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;

-- ── 4. Objects created later, by the owner that runs migrations ─────────
-- Without this every new table added by a migration is invisible to the app
-- until someone remembers to re-run the grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO app_user;

-- ── 5. RLS policies for the app role ────────────────────────────────────
-- Once the app is non-owner, RLS applies to IT. Every table that already has
-- RLS enabled needs a policy for app_user, or that feature breaks the moment
-- DATABASE_URL changes. This loop covers them generically and is idempotent.
--
-- `USING (true)` is correct HERE and nowhere else: app_user is a server-only
-- credential (never shipped to a browser), and the app legitimately reads
-- other players' public rows (leaderboards, profiles, reviews). The roles that
-- must be denied — anon / authenticated, i.e. anything holding the publishable
-- key — get NO policy and no grant, which is what 0268/0269 guarantee.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS app_user_all ON public.%I', t.relname);
    EXECUTE format(
      'CREATE POLICY app_user_all ON public.%I FOR ALL TO app_user USING (true) WITH CHECK (true)',
      t.relname
    );
  END LOOP;
END $$;

-- ── 6. Verification — read this before switching DATABASE_URL ───────────
\echo '── role attributes (must be rolsuper=f, rolbypassrls=f) ────────────'
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
FROM pg_roles WHERE rolname = 'app_user';

\echo '── tables the app could not read (RLS on, no app_user policy) ──────'
SELECT c.relname AS missing_app_user_policy
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
  AND NOT EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = c.oid
      AND 'app_user'::regrole = ANY (p.polroles)
  )
ORDER BY c.relname;

\echo '── tables the app could not write (no DML grant) ───────────────────'
SELECT c.relname AS missing_privilege
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT has_table_privilege('app_user', c.oid, 'SELECT')
ORDER BY c.relname;

\echo '── public tables still reachable by the Data API roles ─────────────'
SELECT c.relname,
       has_table_privilege('anon', c.oid, 'SELECT')          AS anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND (has_table_privilege('anon', c.oid, 'SELECT')
       OR has_table_privilege('authenticated', c.oid, 'SELECT'))
ORDER BY c.relname;

-- Expected: both "missing" sections EMPTY, role attributes false/false, and
-- the Data API section either empty or containing only tables you deliberately
-- expose for realtime.

-- ── 7. Rollback ─────────────────────────────────────────────────────────
-- Switch DATABASE_URL back to the owner first, then:
--
--   REASSIGN OWNED BY app_user TO postgres;   -- only if it owns anything
--   DROP OWNED BY app_user;
--   DROP ROLE app_user;
--
-- Dropping the role removes its policies from every table with it.
