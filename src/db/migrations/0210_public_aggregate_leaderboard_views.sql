-- 0210: Public views for the two AGGREGATE leaderboard boards.
--
-- ── Why this file exists ────────────────────────────────────────────────
-- The stage-2 goal is to stop paying Worker CPU for public leaderboard reads.
-- The per-game boards are simple row lists (0209's `leaderboard_rows`), but
-- two of the eight `/classement` tabs are not row lists at all — they are
-- aggregates that only exist as SQL:
--
--   * Overall Elo       — the arithmetic MEAN of a player's ESTABLISHED
--                         per-game ratings, restricted to players with an
--                         established rating in >= OVERALL_MIN_GAMES games.
--   * Overall Trophies  — the SUM of a player's per-game trophy counts,
--                         restricted to players with a trophy row in
--                         >= OVERALL_TROPHY_MIN_GAMES games.
--
-- Neither has a stored value and neither has a writer: each is recomputed from
-- the same `player_ratings` / `player_trophies` rows the per-game boards read.
-- A browser client cannot reproduce them — PostgREST cannot GROUP BY, and
-- recomputing a mean or a sum over only the current page would be wrong — so
-- the aggregation has to live in the database and be read as a plain relation.
--
-- ── The definitions are copies of the live queries ON PURPOSE ────────────
-- The SQL below is `fetchOverallEloLeaderboard` (src/lib/rating.js) and
-- `fetchOverallTrophyLeaderboard` (src/lib/trophyStore.js), transcribed column
-- for column so a board read from here and a board read from the route return
-- the same numbers for the same player. The constants are inlined rather than
-- hard-coded by memory:
--
--   * `r.games_rated >= 10`   — PROVISIONAL_GAMES (src/lib/elo.js)
--   * `HAVING COUNT(*) >= 3`  — OVERALL_MIN_GAMES (src/lib/elo.js)
--                              and OVERALL_TROPHY_MIN_GAMES (src/lib/trophies.js)
--
-- CRITICAL MAINTENANCE NOTE: these two thresholds now exist in two places.
-- If PROVISIONAL_GAMES, OVERALL_MIN_GAMES or OVERALL_TROPHY_MIN_GAMES ever
-- change, this file's successors must change with them or the browser board
-- and the route will disagree. The `rank` column has the same caveat: it is
-- `ROW_NUMBER()` over the WHOLE eligible set (not the page), which is what
-- makes a player's true rank survive the cutover — the routes had to pay a
-- second uncached query for that.
--
-- ── Privileges ──────────────────────────────────────────────────────────
-- Both views are created WITHOUT `security_invoker`, so they execute with the
-- owner's privileges (`postgres`: the table owner, `rolbypassrls = true`).
-- That is what lets them read `users` while `users` stays closed to PostgREST
-- (0207's deny policy) — the SELECT grant on each view is the entire access
-- boundary, so the column lists below are the thing to review.
--
-- `u.clerk_id` IS projected, for the same reason `leaderboard_rows` now
-- projects it: `PageClient.jsx` links each row to `/profil/<clerk_id>` and
-- marks the viewer's own row with it, and the routes already serve every
-- player's `clerk_id` to anonymous callers under a public cache header — so
-- this is parity, not a new disclosure.
--
-- `u.name` is the display column, NOT `u.username`: `username` is NULL for
-- every row in this database while the API renders `u.name`.
--
-- Idempotent: CREATE OR REPLACE VIEW, and GRANT/REVOKE are idempotent.
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_overall_elo AS
WITH eligible AS (
  SELECT
    r.user_id,
    AVG(r.rating)::numeric AS overall_rating,
    COUNT(*)::int AS eligible_games
  FROM public.player_ratings r
  WHERE r.games_rated >= 10  -- PROVISIONAL_GAMES (src/lib/elo.js)
  GROUP BY r.user_id
  HAVING COUNT(*) >= 3       -- OVERALL_MIN_GAMES (src/lib/elo.js)
)
SELECT
  ROW_NUMBER() OVER (
    ORDER BY e.overall_rating DESC, u.id ASC
  )::int AS rank,
  u.clerk_id,
  u.name,
  u.selected_icon AS icon_key,
  ROUND(e.overall_rating)::int AS overall_elo,
  e.eligible_games,
  jsonb_build_object('name', u.name, 'icon_key', u.selected_icon) AS "user"
FROM eligible e
INNER JOIN public.users u ON u.id = e.user_id;
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_overall_trophies AS
WITH eligible AS (
  SELECT
    t.user_id,
    SUM(t.trophies)::int AS overall_trophies,
    COUNT(*)::int AS games_played
  FROM public.player_trophies t
  GROUP BY t.user_id
  HAVING COUNT(*) >= 3       -- OVERALL_TROPHY_MIN_GAMES (src/lib/trophies.js)
)
SELECT
  ROW_NUMBER() OVER (
    ORDER BY e.overall_trophies DESC, u.id ASC
  )::int AS rank,
  u.clerk_id,
  u.name,
  u.selected_icon AS icon_key,
  e.overall_trophies,
  e.games_played,
  jsonb_build_object('name', u.name, 'icon_key', u.selected_icon) AS "user"
FROM eligible e
INNER JOIN public.users u ON u.id = e.user_id;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_overall_elo TO anon, authenticated;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_overall_trophies TO anon, authenticated;
--> statement-breakpoint

-- Read-only, explicitly: both views are projections, never writable surfaces.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_overall_elo FROM anon, authenticated;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_overall_trophies FROM anon, authenticated;
