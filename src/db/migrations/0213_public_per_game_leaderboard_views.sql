-- 0213: Public views for the per-game Elo and trophy leaderboards.
--
-- ── One relation per board, every game inside it ────────────────────────
-- The routes take `?game=<key>` and filter `WHERE game_key = <key>` inside a
-- CTE, then rank. A view cannot be parameterised that way, so these partition
-- the window instead:
--
--   ROW_NUMBER() OVER (PARTITION BY <game_key> ORDER BY ...)
--
-- Because the route's `ranked` CTE is already filtered to a single game, a
-- per-game partition reproduces its 1..n numbering exactly — and one relation
-- now serves every game. The browser filters with `game_key=eq.<key>` and
-- orders by `rank`, which is also what makes deep pagination correct.
--
-- ── Why there is no sanity filter here ──────────────────────────────────
-- `recordSanityClause` guards the `user_stats` boards (0211, 0212), where the
-- W/L counters are denormalised and can be hand-seeded. These views read
-- `player_ratings` / `player_trophies`, whose rows are written only by the
-- rating and trophy writers, and the routes deliberately apply no such filter
-- to them — so neither do these views. Adding one would silently drop players
-- the Worker still lists.
--
-- ── Ordering and tie-breaks ─────────────────────────────────────────────
-- Elo:    rating DESC, losses ASC, users.id ASC
-- Trophy: trophies DESC, losses ASC, users.id ASC
-- Both transcribed from fetchRatingLeaderboard / fetchTrophyLeaderboard.
--
-- ── What is NOT exposed ─────────────────────────────────────────────────
-- Profile frames (equipped_cosmetics / profileFrame) for the same reason as
-- 0211. The `provisional*` fields the route derives (`toRatingShape` →
-- `provisionalProgress`) are also not columns here: they are a pure function of
-- `games_rated` and `rating` plus PROVISIONAL_GAMES = 10, both of which ARE
-- exposed, so a client computes them with the shared helper rather than
-- duplicating the thresholds in SQL.
--
-- Idempotent: CREATE OR REPLACE VIEW, and GRANT/REVOKE are idempotent.
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_game_ratings AS
WITH ranked AS (
  SELECT
    ROW_NUMBER() OVER (
      PARTITION BY r.game_key
      ORDER BY r.rating DESC, r.losses ASC, u.id ASC
    )::int AS rank,
    r.game_key,
    u.clerk_id,
    u.name,
    u.selected_icon AS icon_key,
    r.rating,
    r.peak_rating,
    r.games_rated,
    r.wins,
    r.losses,
    r.draws,
    r.last_delta,
    r.last_rated_at,
    CASE
      WHEN (r.wins + r.losses) > 0
        THEN ROUND((r.wins::numeric / (r.wins + r.losses)) * 100, 2)
      ELSE 0
    END AS win_rate,
    (r.wins + r.losses) AS games,
    o2.overall_elo AS overall_elo,
    COALESCE(o2.overall_games, 0) AS overall_games,
    jsonb_build_object('name', u.name, 'icon_key', u.selected_icon) AS "user"
  FROM public.player_ratings r
  INNER JOIN public.users u ON u.id = r.user_id
  LEFT JOIN (
    SELECT r2.user_id,
           ROUND(AVG(r2.rating))::int AS overall_elo,
           COUNT(*)::int AS overall_games
    FROM public.player_ratings r2
    WHERE r2.games_rated >= 10   -- PROVISIONAL_GAMES
    GROUP BY r2.user_id
    HAVING COUNT(*) >= 3        -- OVERALL_MIN_GAMES
  ) o2 ON o2.user_id = r.user_id
)
SELECT * FROM ranked;
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_game_trophies AS
WITH ranked AS (
  SELECT
    ROW_NUMBER() OVER (
      PARTITION BY t.game_key
      ORDER BY t.trophies DESC, t.losses ASC, u.id ASC
    )::int AS rank,
    t.game_key,
    u.clerk_id,
    u.name,
    u.selected_icon AS icon_key,
    t.trophies,
    t.peak_trophies,
    t.games_rated,
    t.wins,
    t.losses,
    t.draws,
    t.last_delta,
    t.last_trophy_at,
    CASE
      WHEN (t.wins + t.losses) > 0
        THEN ROUND((t.wins::numeric / (t.wins + t.losses)) * 100, 2)
      ELSE 0
    END AS win_rate,
    (t.wins + t.losses) AS games,
    -- The Overall Trophies badge: an independent cross-game aggregate, absent
    -- until the player has trophy rows in enough different games.
    o2.overall_trophies AS overall_trophies,
    COALESCE(o2.overall_games, 0) AS overall_games,
    jsonb_build_object('name', u.name, 'icon_key', u.selected_icon) AS "user"
  FROM public.player_trophies t
  INNER JOIN public.users u ON u.id = t.user_id
  LEFT JOIN (
    SELECT t2.user_id,
           SUM(t2.trophies)::int AS overall_trophies,
           COUNT(*)::int AS overall_games
    FROM public.player_trophies t2
    GROUP BY t2.user_id
    HAVING COUNT(*) >= 3        -- OVERALL_TROPHY_MIN_GAMES
  ) o2 ON o2.user_id = t.user_id
)
SELECT * FROM ranked;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_game_ratings TO anon, authenticated;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_game_trophies TO anon, authenticated;
--> statement-breakpoint

-- Read-only, explicitly: both views are projections, never writable surfaces.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_game_ratings FROM anon, authenticated;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_game_trophies FROM anon, authenticated;
