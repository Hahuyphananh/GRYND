-- 0214: Give the board views the player's profile frame.
--
-- ── The gap this closes ─────────────────────────────────────────────────
-- 0211/0212 deliberately omitted `equipped_cosmetics`, because the routes strip
-- that raw map before it leaves the server (`attachProfileFrames`) and
-- publishing it here would widen the database surface. The consequence was that
-- a board read from PostgREST rendered WITHOUT profile frames — a visible
-- regression against the Worker, and the one field the REST parity check still
-- reported as missing.
--
-- The fix is not to expose the raw map but to expose the RESOLVED decoration,
-- which is what the routes actually send the client:
--
--   { key, name, visual, avatarEffect, usernameEffect }
--
-- `name` and `visual` are public catalog data (the same cosmetic is shown in the
-- shop), and the resolution mirrors `getFrameDecorations` exactly: the equipped
-- key is looked up per category, `enabled` must be true, and an unknown,
-- disabled or wrong-category key silently resolves to null so a stale equipped
-- key can never render. A decoration with no frame and no effects is null, which
-- is how the UI hides an empty badge.
--
-- Verified against production before writing: `cosmetics` carries the
-- `profile_frame`, `avatar_effect` and `username_effect` categories, all 12 rows
-- are enabled, and exactly one user has a frame equipped
-- (`{"profile_frame": "frame-inferno", "avatar_effect": "avatar-soft-aura"}`),
-- so the column is non-null for that player and null for everyone else.
--
-- ── Only where the route provides it ────────────────────────────────────
-- `fetchRankedRows` (all-time, weekly, streaks) attaches frames;
-- `fetchRatingLeaderboard` does NOT. So the three `user_stats` boards gain the
-- column and the per-game Elo board deliberately does not — matching the Worker
-- exactly rather than adding surface nothing reads.
--
-- Idempotent: CREATE OR REPLACE FUNCTION/VIEW, and GRANT/REVOKE are idempotent.
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.leaderboard_profile_frame(p_equipped jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
-- SECURITY DEFINER, and this is load-bearing rather than a convenience: the
-- resolver reads the `cosmetics` catalog, which `anon` may NOT read (verified:
-- `has_table_privilege('anon','public.cosmetics','SELECT')` is false). As a
-- SECURITY INVOKER function it ran as `anon` and every board read failed with
-- `42501 permission denied for table cosmetics`.
--
-- Defining it as DEFINER makes it run as its owner (`postgres`), exactly like
-- the views around it, so the caller receives the RESOLVED decoration without
-- ever being granted the catalog. The narrow fix is the function's definer
-- rights, NOT a grant on `cosmetics` — anything granted there would expose the
-- whole catalog and its `unlock_condition` column, not just the frames.
SECURITY DEFINER
-- Pin the search path so the DEFINER rights cannot be redirected at a
-- same-named table in another schema.
SET search_path = pg_catalog, public
AS $$
  WITH keys AS (
    SELECT
      NULLIF(p_equipped ->> 'profile_frame', '') AS frame_key,
      NULLIF(p_equipped ->> 'avatar_effect', '') AS avatar_key,
      NULLIF(p_equipped ->> 'username_effect', '') AS username_key
  )
  SELECT
    CASE
      WHEN f.key IS NULL AND a.key IS NULL AND s.key IS NULL THEN NULL
      ELSE jsonb_build_object(
        'key', f.key,
        'name', f.name,
        'visual', f.visual,
        'avatarEffect', CASE
          WHEN a.key IS NULL THEN NULL
          ELSE jsonb_build_object('key', a.key, 'name', a.name, 'visual', a.visual)
        END,
        'usernameEffect', CASE
          WHEN s.key IS NULL THEN NULL
          ELSE jsonb_build_object('key', s.key, 'name', s.name, 'visual', s.visual)
        END
      )
    END
  FROM keys
  LEFT JOIN public.cosmetics f
    ON f.key = keys.frame_key AND f.category = 'profile_frame' AND f.enabled = true
  LEFT JOIN public.cosmetics a
    ON a.key = keys.avatar_key AND a.category = 'avatar_effect' AND a.enabled = true
  LEFT JOIN public.cosmetics s
    ON s.key = keys.username_key AND s.category = 'username_effect' AND s.enabled = true
$$;
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
    public.leaderboard_profile_frame(u.equipped_cosmetics) AS profile_frame,
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
  ROW_NUMBER() OVER (
    ORDER BY w DESC, l ASC, user_id ASC
  )::int AS rank_wins,
  CASE
    WHEN (w + l) >= 10 THEN ROW_NUMBER() OVER (
      PARTITION BY ((w + l) >= 10)
      ORDER BY (CASE WHEN (w + l) > 0 THEN ROUND((w / NULLIF((w + l), 0)) * 100, 2) ELSE 0 END) DESC,
               w DESC, user_id ASC
    )::int
    ELSE NULL
  END AS rank_win_rate,
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
  )::int AS rank_current_streak,
  -- Appended LAST on purpose: CREATE OR REPLACE VIEW cannot reorder or rename
  -- existing columns, so a new column may only be added at the end.
  profile_frame
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
    public.leaderboard_profile_frame(u.equipped_cosmetics) AS profile_frame,
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
  ROW_NUMBER() OVER (
    ORDER BY ww DESC, wl ASC, user_id ASC
  )::int AS rank_wins,
  CASE
    WHEN (ww + wl) >= 5 THEN ROW_NUMBER() OVER (
      PARTITION BY ((ww + wl) >= 5)
      ORDER BY (CASE WHEN (ww + wl) > 0 THEN ROUND((ww / NULLIF((ww + wl), 0)) * 100, 2) ELSE 0 END) DESC,
               ww DESC, user_id ASC
    )::int
    ELSE NULL
  END AS rank_win_rate,
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
  )::int AS rank_current_streak,
  profile_frame
FROM base;
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
    public.leaderboard_profile_frame(u.equipped_cosmetics) AS profile_frame,
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
  )::int AS rank_weekly_streak_best,
  profile_frame
FROM base;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_all_time TO anon, authenticated;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_weekly TO anon, authenticated;
--> statement-breakpoint

GRANT SELECT ON public.leaderboard_streaks TO anon, authenticated;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_all_time FROM anon, authenticated;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_weekly FROM anon, authenticated;
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.leaderboard_streaks FROM anon, authenticated;
--> statement-breakpoint

-- The resolver reads the catalog as the view owner; callers only ever get the
-- resolved decoration, never the raw equipped map.
REVOKE ALL ON FUNCTION public.leaderboard_profile_frame(jsonb) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.leaderboard_profile_frame(jsonb)
  TO anon, authenticated;
