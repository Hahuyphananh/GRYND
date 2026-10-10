-- 0211: Public views for the all-time and weekly leaderboards.
--
-- ── What these boards actually read ─────────────────────────────────────
-- Unlike the Elo/trophy boards (0209, 0210), these rank on `user_stats`, which
-- is populated in production (25 rows) — so these are the boards that have
-- data to show. Every metric is derived on read; nothing is stored.
--
-- The route (`src/lib/leaderboardQueries.js`) resolves its columns at runtime
-- through `getLeaderboardColumns()` and therefore tolerates a schema missing
-- any of them. A view cannot: it must name what exists. The resolutions below
-- are the ones this database actually produces, read from
-- information_schema rather than assumed:
--
--   * wins / losses / total_bets / best_streak / current_streak, the weekly
--     counters and all four streak counters: present on `user_stats`, so the
--     route picks `s.<column>` (checked before the `users` fallback).
--   * pvp_wins: NOT on `user_stats`. There is no weekly counterpart, and the
--     `users` fallback is used — `COALESCE(u.pvp_wins, 0)::int`.
--   * `user_stats.win_rate` exists but is IGNORED by the route: the win rate
--     is recomputed from wins/losses, so this view recomputes it too.
--
-- ── Ranks without a self-join ───────────────────────────────────────────
-- Each board needs its own ranking, and the `win_rate` tab must rank ONLY the
-- players who clear its sample-size floor. `ROW_NUMBER() OVER
-- (PARTITION BY <eligible> ORDER BY ...)` does exactly that: the eligible
-- partition numbers 1..n contiguously, so those ranks are identical to the
-- route's, which filters first and then numbers. Ineligible rows still appear
-- (with a rank from the other partition) so the client must select on
-- `rank_win_rate IS NOT NULL` for that tab — see the note at the bottom.
--
-- ── Same exclusions as the route ────────────────────────────────────────
-- `recordSanityClause` drops hand-seeded impossible records — rows where
-- wins + losses exceeds total_bets, which the app's own writer can never
-- produce because it increments both in one statement. This database HAS such
-- a row (user 20: wins 5000, losses 0, total_bets 413), so the filter is
-- load-bearing, not theoretical. It is applied as a WHERE here exactly as the
-- route applies it, so an excluded account does not rank and does not displace
-- anyone's rank either.
--
-- `equipped_cosmetics` and the derived `profileFrame` are deliberately NOT
-- exposed: the route strips the raw map before it leaves the server
-- (attachProfileFrames), so publishing it here would widen the surface. The
-- consequence is that a client-side board renders WITHOUT profile frames until
-- the cosmetics catalog is joined (a separate migration). KNOWN GAP.
--
-- Idempotent: CREATE OR REPLACE VIEW, and GRANT/REVOKE are idempotent.
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_all_time AS
WITH base AS (
  SELECT
    s.user_id,
    u.clerk_id,
    u.name,
    u.selected_icon AS icon_key,
    COALESCE(s.wins, 0)::numeric AS w,
    COALESCE(s.losses, 0)::numeric AS l,
    COALESCE(s.total_bets, 0)::int AS games,
    COALESCE(s.best_streak, 0)::int AS best_streak,
    COALESCE(s.current_streak, 0)::int AS current_streak,
    COALESCE(u.pvp_wins, 0)::int AS pvp_wins,
    o.overall_elo AS overall_elo,
    COALESCE(o.overall_games, 0) AS overall_games
  FROM public.user_stats s
  INNER JOIN public.users u ON u.id = s.user_id
  LEFT JOIN (
    SELECT r.user_id,
           ROUND(AVG(r.rating))::int AS overall_elo,
           COUNT(*)::int AS overall_games
    FROM public.player_ratings r
    WHERE r.games_rated >= 10   -- PROVISIONAL_GAMES
    GROUP BY r.user_id
    HAVING COUNT(*) >= 3        -- OVERALL_MIN_GAMES
  ) o ON o.user_id = s.user_id
  -- recordSanityClause: identical to the route's, condition for condition.
  WHERE COALESCE(s.wins, 0) >= 0
    AND COALESCE(s.losses, 0) >= 0
    AND (COALESCE(s.wins, 0) + COALESCE(s.losses, 0)) <= COALESCE(s.total_bets, 0)
)
SELECT
  user_id,
  clerk_id,
  name,
  icon_key,
  overall_elo,
  overall_games,
  w::int AS wins,
  l::int AS losses,
  CASE
    WHEN (w + l) > 0 THEN ROUND((w / NULLIF((w + l), 0)) * 100, 2)
    ELSE 0
  END AS win_rate,
  games,
  current_streak,
  best_streak,
  pvp_wins,
  (w::int - l::int) AS net_wins,
  CASE
    WHEN l > 0 THEN ROUND((w / l)::numeric, 2)
    WHEN w > 0 THEN w
    ELSE 0
  END AS win_loss_ratio,
  jsonb_build_object('name', name, 'icon_key', icon_key) AS "user",
  -- One rank column per `LEADERBOARD_CATEGORIES` entry, in the route's order.
  ROW_NUMBER() OVER (
    ORDER BY w DESC, l ASC, user_id ASC
  )::int AS rank_wins,
  ROW_NUMBER() OVER (
    PARTITION BY ((w + l) >= 10)
    ORDER BY (CASE WHEN (w + l) > 0 THEN ROUND((w / NULLIF((w + l), 0)) * 100, 2) ELSE 0 END) DESC,
             w DESC, user_id ASC
  )::int AS rank_win_rate,
  ROW_NUMBER() OVER (
    ORDER BY games DESC, user_id ASC
  )::int AS rank_games,
  ROW_NUMBER() OVER (
    ORDER BY best_streak DESC, user_id ASC
  )::int AS rank_best_streak,
  ROW_NUMBER() OVER (
    ORDER BY pvp_wins DESC, user_id ASC
  )::int AS rank_pvp_wins,
  ROW_NUMBER() OVER (
    ORDER BY (w::int - l::int) DESC, w DESC, user_id ASC
  )::int AS rank_net_wins,
  ROW_NUMBER() OVER (
    ORDER BY (CASE WHEN l > 0 THEN ROUND((w / l)::numeric, 2) WHEN w > 0 THEN w ELSE 0 END) DESC,
             w DESC, user_id ASC
  )::int AS rank_win_loss_ratio,
  ROW_NUMBER() OVER (
    ORDER BY current_streak DESC, user_id ASC
  )::int AS rank_current_streak
FROM base;
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_weekly AS
WITH base AS (
  SELECT
    s.user_id,
    u.clerk_id,
    u.name,
    u.selected_icon AS icon_key,
    COALESCE(s.weekly_wins, 0)::numeric AS ww,
    COALESCE(s.weekly_losses, 0)::numeric AS wl,
    COALESCE(s.weekly_best_streak, 0)::int AS weekly_best_streak,
    COALESCE(s.weekly_game_streak, 0)::int AS weekly_game_streak,
    o.overall_elo AS overall_elo,
    COALESCE(o.overall_games, 0) AS overall_games
  FROM public.user_stats s
  INNER JOIN public.users u ON u.id = s.user_id
  LEFT JOIN (
    SELECT r.user_id,
           ROUND(AVG(r.rating))::int AS overall_elo,
           COUNT(*)::int AS overall_games
    FROM public.player_ratings r
    WHERE r.games_rated >= 10   -- PROVISIONAL_GAMES
    GROUP BY r.user_id
    HAVING COUNT(*) >= 3        -- OVERALL_MIN_GAMES
  ) o ON o.user_id = s.user_id
  WHERE COALESCE(s.wins, 0) >= 0
    AND COALESCE(s.losses, 0) >= 0
    AND (COALESCE(s.wins, 0) + COALESCE(s.losses, 0)) <= COALESCE(s.total_bets, 0)
)
SELECT
  user_id,
  clerk_id,
  name,
  icon_key,
  overall_elo,
  overall_games,
  ww::int AS weekly_wins,
  wl::int AS weekly_losses,
  CASE
    WHEN (ww + wl) > 0 THEN ROUND((ww / NULLIF((ww + wl), 0)) * 100, 2)
    ELSE 0
  END AS weekly_win_rate,
  (ww::int + wl::int) AS weekly_games,
  weekly_game_streak AS weekly_current_streak,
  weekly_best_streak,
  (ww::int - wl::int) AS weekly_net_wins,
  CASE
    WHEN wl > 0 THEN ROUND((ww / wl)::numeric, 2)
    WHEN ww > 0 THEN ww
    ELSE 0
  END AS weekly_win_loss_ratio,
  jsonb_build_object('name', name, 'icon_key', icon_key) AS "user",
  -- One rank column per `WEEKLY_CATEGORIES` entry (no `pvp_wins`: there is no
  -- weekly PvP counter). The win-rate floor is 5 games, not 10.
  ROW_NUMBER() OVER (
    ORDER BY ww DESC, wl ASC, user_id ASC
  )::int AS rank_wins,
  ROW_NUMBER() OVER (
    PARTITION BY ((ww + wl) >= 5)
    ORDER BY (CASE WHEN (ww + wl) > 0 THEN ROUND((ww / NULLIF((ww + wl), 0)) * 100, 2) ELSE 0 END) DESC,
             ww DESC, user_id ASC
  )::int AS rank_win_rate,
  ROW_NUMBER() OVER (
    ORDER BY (ww::int + wl::int) DESC, user_id ASC
  )::int AS rank_games,
  ROW_NUMBER() OVER (
    ORDER BY weekly_best_streak DESC, user_id ASC
  )::int AS rank_best_streak,
  ROW_NUMBER() OVER (
    ORDER BY (ww::int - wl::int) DESC, ww DESC, user_id ASC
  )::int AS rank_net_wins,
  ROW_NUMBER() OVER (
    ORDER BY (CASE WHEN wl > 0 THEN ROUND((ww / wl)::numeric, 2) WHEN ww > 0 THEN ww ELSE 0 END) DESC,
             ww DESC, user_id ASC
  )::int AS rank_win_loss_ratio,
  ROW_NUMBER() OVER (
    ORDER BY weekly_game_streak DESC, user_id ASC
  )::int AS rank_current_streak
FROM base;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_all_time TO anon, authenticated;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_weekly TO anon, authenticated;
--> statement-breakpoint

-- Read-only, explicitly: both views are projections, never writable surfaces.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_all_time FROM anon, authenticated;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_weekly FROM anon, authenticated;
