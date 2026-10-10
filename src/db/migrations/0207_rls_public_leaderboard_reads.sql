-- 0207: Public READ access for the leaderboard's data tables.
--
-- ── Why this file exists ────────────────────────────────────────────────
-- Stage 2 of the Cloudflare migration moves read-only, already-public data off
-- the Worker: a Cloudflare Worker gets 10 ms of CPU per request, and measured
-- page renders needed 38-937 ms, so 5-20% of page loads were killed with error
-- 1102 (exceededCpu). Reads that a browser can do itself should not be server
-- work at all.
--
-- The pilot is the leaderboard, because it is the safest possible first step:
-- /api/leaderboard/{game,overall,trophy,trophy-overall} are anonymous,
-- read-only, rate-limited endpoints that already return these rows to anyone,
-- signed in or not.
--
-- ── Why this cannot change how the app behaves ──────────────────────────
-- Verified against the live database before writing this file:
--
--   * the application connects as `postgres`, which OWNS player_ratings and
--     player_trophies and has `rolbypassrls = true`. Policies and grants for
--     other roles are never evaluated for it, so game logic, sign-up, token
--     flows and every server-side query behave exactly as before.
--   * neither `anon` nor `authenticated` holds ANY privilege on these tables
--     today (Supabase no longer grants the `public` schema by default), and
--     nothing in the app calls PostgREST from the browser yet — so this file
--     adds a capability where there was none; it does not move an existing
--     boundary.
--
-- ── The no-new-exposure argument ────────────────────────────────────────
-- `player_ratings` and `player_trophies` hold only competitive statistics —
-- rating, peak, games rated, wins/losses/draws, last delta, timestamps. No
-- money columns, no PII, no hidden state. That is precisely what the public
-- endpoints above return, so SELECT for `anon` reveals nothing a visitor
-- cannot already fetch, while being strictly narrower than the API (no
-- endpoint can be asked for an arbitrary row).
--
-- ── What is deliberately NOT here ───────────────────────────────────────
-- `users` gets NO policy and NO grant. It has 71 columns including `email`,
-- `password`, `is_admin`, `ban_reason`, `balance` and `daily_loss_limit`, and
-- RLS policies are row-level, not column-level: a table-level policy plus the
-- usual grants would expose every column of every row to anyone holding the
-- publishable key. The leaderboard's usernames/avatars need either a dedicated
-- view exposing only the display columns, or column-level GRANTs — a separate
-- decision with its own review. Until then `users` stays explicitly closed,
-- and the deny policy below makes that intent enforced rather than incidental.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY (there is no IF NOT EXISTS
-- for CREATE POLICY), and GRANT/REVOKE are idempotent by nature.
--> statement-breakpoint

-- ── player_ratings: the per-game and overall Elo boards ────────────────
ALTER TABLE "player_ratings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "player_ratings" TO anon, authenticated;
--> statement-breakpoint
-- Read-only, explicitly: no client may write a rating.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "player_ratings"
  FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "public_read_leaderboard" ON "player_ratings";
--> statement-breakpoint
CREATE POLICY "public_read_leaderboard" ON "player_ratings"
  FOR SELECT TO anon, authenticated USING (true);
--> statement-breakpoint

-- ── player_trophies: the trophy boards ─────────────────────────────────
ALTER TABLE "player_trophies" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON "player_trophies" TO anon, authenticated;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "player_trophies"
  FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "public_read_leaderboard" ON "player_trophies";
--> statement-breakpoint
CREATE POLICY "public_read_leaderboard" ON "player_trophies"
  FOR SELECT TO anon, authenticated USING (true);
--> statement-breakpoint

-- ── users: stays closed, on purpose (see the header) ───────────────────
-- A permissive policy that matches nothing is the same intent as the existing
-- "no_direct_client_access" policies on the token tables: it documents the
-- decision where a future reader will look for it, and it keeps denying access
-- even if someone later grants SELECT broadly by mistake.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "users" FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "no_direct_client_access" ON "users";
--> statement-breakpoint
CREATE POLICY "no_direct_client_access" ON "users"
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
