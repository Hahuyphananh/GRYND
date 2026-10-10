-- 0212: Public view for the four streak leaderboard tabs.
--
-- ── One view, four tabs ─────────────────────────────────────────────────
-- `/api/leaderboard/daily-streak` serves four different boards off one route,
-- chosen by `?type=`: `current` and `best` rank on the daily streak counters
-- (`fetchDailyStreakLeaderboard`), while `weekly-current` and `weekly-best`
-- rank on the weekly ones (`fetchWeeklyStreakLeaderboard`). Each board carries
-- the same all-time W/L mini-stats so a row can show the player's record under
-- their name, and the four orderings differ only in which counter they sort
-- by — so all four fit in a single relation with one rank column each.
--
-- Every counter resolves to `user_stats` on this database:
--   daily_streak_current, daily_streak_best, weekly_streak_current,
--   weekly_streak_best — all present, all `COALESCE(..., 0)::int`.
--
-- `recordSanityClause` is applied exactly as the route applies it, so the
-- fabricated record (user 20: wins 5000, losses 0, total_bets 413) does not
-- rank here either. `equipped_cosmetics`/`profileFrame` are omitted for the
-- same reason as 0211 — see that file's note. Known gap.
--
-- Idempotent: CREATE OR REPLACE VIEW, and GRANT/REVOKE are idempotent.
--> statement-breakpoint

CREATE OR REPLACE VIEW public.leaderboard_streaks AS
WITH base AS (
  SELECT
    s.user_id,
    u.clerk_id,
    u.name,
    u.selected_icon AS icon_key,
    COALESCE(s.wins, 0)::numeric AS w,
    COALESCE(s.losses, 0)::numeric AS l,
    COALESCE(s.total_bets, 0)::int AS games,
    COALESCE(s.current_streak, 0)::int AS current_streak,
    COALESCE(s.daily_streak_current, 0)::int AS daily_streak_current,
    COALESCE(s.daily_streak_best, 0)::int AS daily_streak_best,
    COALESCE(s.weekly_streak_current, 0)::int AS weekly_streak_current,
    COALESCE(s.weekly_streak_best, 0)::int AS weekly_streak_best,
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
  -- The all-time mini-stats every streak row carries.
  w::int AS wins,
  l::int AS losses,
  CASE
    WHEN (w + l) > 0 THEN ROUND((w / NULLIF((w + l), 0)) * 100, 2)
    ELSE 0
  END AS win_rate,
  games,
  current_streak,
  daily_streak_current,
  daily_streak_best,
  weekly_streak_current,
  weekly_streak_best,
  jsonb_build_object('name', name, 'icon_key', icon_key) AS "user",
  -- One rank column per `?type=` value the route accepts.
  ROW_NUMBER() OVER (
    ORDER BY daily_streak_current DESC, user_id ASC
  )::int AS rank_daily_streak_current,
  ROW_NUMBER() OVER (
    ORDER BY daily_streak_best DESC, user_id ASC
  )::int AS rank_daily_streak_best,
  ROW_NUMBER() OVER (
    ORDER BY weekly_streak_current DESC, user_id ASC
  )::int AS rank_weekly_streak_current,
  ROW_NUMBER() OVER (
    ORDER BY weekly_streak_best DESC, user_id ASC
  )::int AS rank_weekly_streak_best
FROM base;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_streaks TO anon, authenticated;
--> statement-breakpoint

-- Read-only, explicitly: the view is a projection, never a writable surface.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_streaks FROM anon, authenticated;
