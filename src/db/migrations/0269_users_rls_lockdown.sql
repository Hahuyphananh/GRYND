-- 0269: put Row Level Security on `users` and take the Data API roles off it.
--
-- WHY
-- ---
-- `users` holds the highest-value row set in the product: verified email,
-- password hash, Clerk id, `is_admin`, balance, and the age/birthdate record.
-- It had NO Row Level Security at all: no `ENABLE ROW LEVEL SECURITY` in any
-- migration, and no `FORCE ROW LEVEL SECURITY` either.
--
-- The application pool connects as the table OWNER, so table privileges are
-- what protect this table today — and Supabase's default `public` schema
-- grants give `anon` and `authenticated` access to public tables. The
-- publishable key ships in the browser bundle, so any leftover grant is a
-- direct read path to every user row.
--
-- What this migration does, and what it deliberately does NOT do:
--
--   * enables RLS, so a non-owner role sees nothing without a policy;
--   * revokes anon/authenticated privileges, so the Data API roles cannot
--     even reach the table;
--   * leaves `service_role` intact (bypasses RLS; used by server-side jobs);
--   * does NOT set FORCE ROW LEVEL SECURITY. The app connects as the owner and
--     reads/writes users on every request; forcing RLS would block it unless
--     every query moved to a non-owner role first. That is a separate,
--     deployment-level change (see docs/security-fixes/db-authz-audit.sql).
--
-- The app's browser client (src/lib/realtime.ts) subscribes to `chat_messages`
-- and `solitaire_duel_matches`, never to `users`, so no realtime channel is
-- affected by this.
--
-- Idempotent, and role-guarded so it also applies on a plain Postgres host
-- that has no anon/authenticated/service_role roles.

DO $$
BEGIN
  IF to_regclass('users') IS NULL THEN
    RAISE NOTICE 'users does not exist; nothing to lock down';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE users ENABLE ROW LEVEL SECURITY';

  -- No policy is created on purpose: the owner connection works, every other
  -- role is denied by default. A policy here would be a capability, and the
  -- app never reads this table through the Data API.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE users FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE users FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL PRIVILEGES ON TABLE users TO service_role';
  END IF;
END $$;

-- Verify after applying:
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'users'::regclass;
--     -- expect true
--   SELECT polname FROM pg_policy WHERE polrelid = 'users'::regclass;
--     -- expect ZERO rows
--   SELECT has_table_privilege('anon', 'users', 'SELECT');
--     -- expect false
--   SELECT has_table_privilege('authenticated', 'users', 'SELECT');
--     -- expect false
