-- ============================================================================
-- RLS + SECURITY DEFINER migration — DRAFT, review before applying
-- ============================================================================
--
-- Goal: stop relying solely on application-layer authorization. Enforce
-- row-level rules in Postgres itself, and expose privileged operations only
-- through SECURITY DEFINER functions.
--
-- ⚠️ READ FIRST — three hard requirements or this will break the app:
--
-- 1) FORCE ROW LEVEL SECURITY is MANDATORY. The app connects as the table
--    owner (Neon's default user created these tables), and RLS does NOT apply
--    to the table owner unless FORCE is set. Without FORCE, every policy below
--    is silently ignored.
--
-- 2) The app must tell Postgres WHO the actor is on every connection. Add a
--    small wrapper around your DB client (src/db/index.ts) that runs
--    `SET LOCAL app.clerk_id = $1; SET LOCAL app.is_admin = $2;` inside every
--    transaction/request (Clerk userId is available in every API route).
--    Until that wrapper exists, policies that read current_setting() will
--    deny everything (fail closed — safe, but the app will look broken).
--
-- 3) Decide the policy surface per table with the team. The examples below
--    cover the common patterns; you must enumerate every table and pick its
--    policy. Run this in staging first, against a COPY of the data.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Step 1 — enable RLS everywhere, FORCED (owner-inclusive)
-- ---------------------------------------------------------------------------
-- List every table (see src/db/schema.ts) then:
--   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
--
-- Representative sample:
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               FORCE ROW LEVEL SECURITY;
ALTER TABLE chess_games         ENABLE ROW LEVEL SECURITY;
ALTER TABLE chess_games         FORCE ROW LEVEL SECURITY;
ALTER TABLE keno_games          ENABLE ROW LEVEL SECURITY;
ALTER TABLE keno_games          FORCE ROW LEVEL SECURITY;
ALTER TABLE user_automation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_automation_state FORCE ROW LEVEL SECURITY;
-- ...repeat for every table...


-- ---------------------------------------------------------------------------
-- Step 2 — actor context helper (called by the app DB wrapper, never by users)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_app_actor(clerk_id text, is_admin boolean DEFAULT false)
RETURNS void
LANGUAGE sql
AS $$
  SELECT set_config('app.clerk_id', clerk_id, true),      -- true = local to tx
         set_config('app.is_admin', is_admin::text, true);
$$;


-- ---------------------------------------------------------------------------
-- Step 3 — example policies
-- ---------------------------------------------------------------------------

-- Users may only read/update their own row (clerk_id = Clerk's user id).
CREATE POLICY users_self ON users
  FOR ALL
  USING (clerk_id = current_setting('app.clerk_id', true))
  WITH CHECK (clerk_id = current_setting('app.clerk_id', true));

-- A game table: participants may read their own games; nobody may update
-- rows they're not part of.
CREATE POLICY chess_games_participant ON chess_games
  FOR SELECT
  USING (
    player_white_id = current_setting('app.clerk_id', true)
    OR player_black_id = current_setting('app.clerk_id', true)
    OR current_setting('app.is_admin', true) = 'true'
  );

-- Public leaderboard reads must not require an actor; route them through a
-- SECURITY DEFINER function instead of opening the table to everyone:
CREATE POLICY keno_games_none ON keno_games
  FOR ALL
  USING (false);   -- table is fully locked; only the function below can read it


-- ---------------------------------------------------------------------------
-- Step 4 — SECURITY DEFINER functions (privileged operations)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER runs as the function OWNER, so it bypasses RLS of the
-- owner's tables. This is how the app credits balances without giving the
-- app role blanket UPDATE rights.

-- Balance credit (called by the payment webhook):
CREATE OR REPLACE FUNCTION public.credit_tokens(
  target_clerk_id text,
  amount numeric
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_balance numeric;
BEGIN
  UPDATE users
     SET balance = balance + amount
   WHERE clerk_id = target_clerk_id
  RETURNING balance INTO new_balance;

  IF new_balance IS NULL THEN
    RAISE EXCEPTION 'user not found: %', target_clerk_id;
  END IF;

  RETURN new_balance;
END;
$$;

-- Leaderboard read for logged-out visitors (bypasses RLS, exposes only
-- aggregate-safe columns):
CREATE OR REPLACE FUNCTION public.get_top_players(limit_n int DEFAULT 20)
RETURNS TABLE (name text, games_won bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT name, games_won FROM users ORDER BY games_won DESC LIMIT limit_n;
$$;


-- ---------------------------------------------------------------------------
-- Step 5 — app-side changes REQUIRED before enabling (see requirement 2)
-- ---------------------------------------------------------------------------
-- 1) src/db/index.ts (or a middleware wrapper): begin every request/query
--    with `SELECT public.set_app_actor('<clerkId>', <isAdmin>)` inside the
--    same transaction.
-- 2) Replace privileged direct writes (balance updates, admin mutations) with
--    calls to SECURITY DEFINER functions.
-- 3) Audit every raw SQL / drizzle query that reads tables the app role no
--    longer has blanket access to.
--
-- Rollback: ALTER TABLE <t> DISABLE ROW LEVEL SECURITY; (policies remain but
-- are inert until re-enabled).
