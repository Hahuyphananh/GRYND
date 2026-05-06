import { sql } from "@vercel/postgres";

export const LEADERBOARD_CATEGORIES = ["level", "total_wagered", "biggest_win", "best_streak", "win_rate"];

const ALL_TIME_CATEGORY_CONFIG = {
  level: {
    fields: "COALESCE(s.level, 0)::int AS level, COALESCE(s.xp, 0)::int AS xp",
    orderBy: "COALESCE(s.level, 0) DESC, COALESCE(s.xp, 0) DESC, s.user_id ASC",
  },
  total_wagered: {
    fields: "COALESCE(s.total_wagered, 0)::numeric AS total_wagered",
    orderBy: "COALESCE(s.total_wagered, 0) DESC, s.user_id ASC",
  },
  biggest_win: {
    fields: "COALESCE(s.biggest_win, 0)::numeric AS biggest_win",
    orderBy: "COALESCE(s.biggest_win, 0) DESC, s.user_id ASC",
  },
  best_streak: {
    fields: "COALESCE(s.best_streak, 0)::int AS best_streak",
    orderBy: "COALESCE(s.best_streak, 0) DESC, s.user_id ASC",
  },
  win_rate: {
    fields: `
      CASE
        WHEN (COALESCE(s.wins, 0) + COALESCE(s.losses, 0)) > 0
          THEN ROUND((COALESCE(s.wins, 0)::numeric / (COALESCE(s.wins, 0) + COALESCE(s.losses, 0))::numeric) * 100, 2)
        ELSE 0
      END AS win_rate,
      COALESCE(s.wins, 0)::int AS wins,
      COALESCE(s.losses, 0)::int AS losses
    `,
    orderBy: `
      CASE
        WHEN (COALESCE(s.wins, 0) + COALESCE(s.losses, 0)) > 0
          THEN (COALESCE(s.wins, 0)::numeric / (COALESCE(s.wins, 0) + COALESCE(s.losses, 0))::numeric) * 100
        ELSE 0
      END DESC,
      COALESCE(s.wins, 0) DESC,
      s.user_id ASC
    `,
  },
};

const WEEKLY_CATEGORY_CONFIG = {
  level: {
    fields: "COALESCE(s.weekly_level_gain, 0)::int AS weekly_level_gain",
    orderBy: "COALESCE(s.weekly_level_gain, 0) DESC, s.user_id ASC",
  },
  total_wagered: {
    fields: "COALESCE(s.weekly_wagered, 0)::numeric AS weekly_wagered",
    orderBy: "COALESCE(s.weekly_wagered, 0) DESC, s.user_id ASC",
  },
  biggest_win: {
    fields: "COALESCE(s.weekly_biggest_win, 0)::numeric AS weekly_biggest_win",
    orderBy: "COALESCE(s.weekly_biggest_win, 0) DESC, s.user_id ASC",
  },
  best_streak: {
    fields: "COALESCE(s.weekly_best_streak, 0)::int AS weekly_best_streak",
    orderBy: "COALESCE(s.weekly_best_streak, 0) DESC, s.user_id ASC",
  },
  win_rate: {
    fields: `
      CASE
        WHEN (COALESCE(s.weekly_wins, 0) + COALESCE(s.weekly_losses, 0)) > 0
          THEN ROUND((COALESCE(s.weekly_wins, 0)::numeric / (COALESCE(s.weekly_wins, 0) + COALESCE(s.weekly_losses, 0))::numeric) * 100, 2)
        ELSE 0
      END AS weekly_win_rate,
      COALESCE(s.weekly_wins, 0)::int AS weekly_wins,
      COALESCE(s.weekly_losses, 0)::int AS weekly_losses
    `,
    orderBy: `
      CASE
        WHEN (COALESCE(s.weekly_wins, 0) + COALESCE(s.weekly_losses, 0)) > 0
          THEN (COALESCE(s.weekly_wins, 0)::numeric / (COALESCE(s.weekly_wins, 0) + COALESCE(s.weekly_losses, 0))::numeric) * 100
        ELSE 0
      END DESC,
      COALESCE(s.weekly_wins, 0) DESC,
      s.user_id ASC
    `,
  },
};

export function clampLeaderboardLimit(value) {
  return Math.min(100, Math.max(1, Number(value) || 20));
}

export function normalizeLeaderboardOffset(value) {
  return Math.max(0, Number(value) || 0);
}

export function normalizeLeaderboardCategory(value) {
  return LEADERBOARD_CATEGORIES.includes(value) ? value : "level";
}

async function fetchRankedRows({ fields, orderBy, limit, offset, clerkId = null }) {
  const params = clerkId ? [limit, offset, clerkId] : [limit, offset];
  const meClause = clerkId ? "(SELECT row_to_json(ranked) FROM ranked WHERE clerk_id = $3 LIMIT 1) AS me" : "NULL AS me";

  const result = await sql.query(
    `
      WITH ranked AS (
        SELECT
          ROW_NUMBER() OVER (ORDER BY ${orderBy})::int AS rank,
          u.clerk_id,
          s.user_id,
          u.name,
          u.profile_picture,
          json_build_object(
            'name', u.name,
            'profile_picture', u.profile_picture
          ) AS "user",
          ${fields}
        FROM user_stats s
        INNER JOIN users u ON u.id = s.user_id
      ),
      paged AS (
        SELECT *
        FROM ranked
        ORDER BY rank ASC
        LIMIT $1 OFFSET $2
      )
      SELECT
        COALESCE(json_agg(paged ORDER BY rank ASC), '[]'::json) AS items,
        ${meClause}
      FROM paged
    `,
    params,
  );

  return {
    items: result.rows[0]?.items ?? [],
    me: result.rows[0]?.me ?? null,
  };
}

export async function fetchAllTimeLeaderboard({ category, limit, offset, clerkId }) {
  const config = ALL_TIME_CATEGORY_CONFIG[normalizeLeaderboardCategory(category)];
  return fetchRankedRows({ ...config, limit, offset, clerkId });
}

export async function fetchWeeklyLeaderboard({ category, limit, offset, clerkId }) {
  const config = WEEKLY_CATEGORY_CONFIG[normalizeLeaderboardCategory(category)];
  return fetchRankedRows({ ...config, limit, offset, clerkId });
}

export async function fetchWinsLeaderboard({ limit, offset, clerkId }) {
  return fetchRankedRows({
    fields: "COALESCE(s.total_won, 0)::numeric AS total_won, COALESCE(s.wins, 0)::int AS wins",
    orderBy: "COALESCE(s.total_won, 0) DESC, COALESCE(s.wins, 0) DESC, s.user_id ASC",
    limit,
    offset,
    clerkId,
  });
}
