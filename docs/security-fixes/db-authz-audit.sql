-- READ-ONLY database authorization audit.
--
-- Run this against STAGING first, then production, with the app's connection
-- string:
--
--   psql "$DATABASE_URL" -f docs/security-fixes/db-authz-audit.sql
--
-- It changes nothing. It answers the questions the repository cannot:
--
--   1. which public tables are readable/writable by the Data API roles
--      (`anon`, `authenticated`) — i.e. by anyone holding the publishable key
--      that ships in the browser bundle;
--   2. which tables have RLS enabled but still carry permissive policies;
--   3. which tables the app does NOT need exposed at all.
--
-- Expected result after migrations 0268 and 0269:
--   * error_logs: no policies, no anon/authenticated privileges;
--   * users:      RLS on, no policies, no anon/authenticated privileges;
--   * everything else: reviewed and either justified or revoked.

\echo '── 1. Tables reachable by the public Data API roles ────────────────'
SELECT
  c.relname                                  AS table_name,
  c.relrowsecurity                           AS rls_enabled,
  c.relforcerowsecurity                      AS rls_forced,
  has_table_privilege('anon', c.oid, 'SELECT')          AS anon_select,
  has_table_privilege('anon', c.oid, 'INSERT')          AS anon_insert,
  has_table_privilege('anon', c.oid, 'UPDATE')          AS anon_update,
  has_table_privilege('anon', c.oid, 'DELETE')          AS anon_delete,
  has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') AS auth_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE') AS auth_update,
  has_table_privilege('authenticated', c.oid, 'DELETE') AS auth_delete
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relname;

\echo '── 2. Policies on public tables (permissive = using/with check true) ─'
SELECT
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  permissive,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

\echo '── 3. Core tables with RLS DISABLED (candidates for 0270+) ────────'
SELECT c.relname AS table_without_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = false
  AND c.relname IN (
    'users', 'user_stats', 'user_icons', 'user_titles', 'user_cosmetics',
    'transactions', 'player_reports', 'contact_messages', 'email_events',
    'game_plays', 'subscriptions'
  )
ORDER BY c.relname;

\echo '── 4. Realtime publication membership (what the browser can subscribe to) ─'
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY schemaname, tablename;

-- ── What to do with the output ──────────────────────────────────────────
--
-- For every row in (1) where anon_select/auth_select is true:
--   * if the app never reads that table with the publishable key, REVOKE it
--     from anon/authenticated and enable RLS with no policies (pattern:
--     0268_error_logs_lockdown.sql);
--   * if a realtime channel depends on it, keep RLS enabled and add the
--     narrowest policy that still serves the channel — never USING (true).
--
-- If (3) still lists high-value tables, extend the pattern to them, one
-- migration per table group, applied on staging first.
