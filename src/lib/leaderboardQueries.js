import { getNeonSql } from "../db/neon";

let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Set it in your runtime environment (for example, Vercel Project Settings > Environment Variables).",
    );
  }
  _sql = getNeonSql();
  return _sql;
}

export const LEADERBOARD_CATEGORIES = [
  "level",
  "total_wagered",
  "biggest_win",
  "best_streak",
  "win_rate",
];

let leaderboardColumnCache = null;

async function getLeaderboardColumns() {
  if (leaderboardColumnCache) return leaderboardColumnCache;

  const result = await getSql().query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = CURRENT_SCHEMA()
        AND table_name IN ('user_stats', 'users')
    `,
  );

  const columns = {
    user_stats: new Set(),
    users: new Set(),
  };

  for (const row of result) {
    if (columns[row.table_name]) columns[row.table_name].add(row.column_name);
  }

  leaderboardColumnCache = columns;
  return columns;
}

function hasColumn(columns, tableName, columnName) {
  return columns[tableName]?.has(columnName) ?? false;
}

function userStatsMetric(
  columns,
  columnName,
  { userFallback = null, defaultValue = "0", cast = "numeric" } = {},
) {
  if (hasColumn(columns, "user_stats", columnName))
    return `COALESCE(s.${columnName}, ${defaultValue})::${cast}`;
  if (userFallback && hasColumn(columns, "users", userFallback))
    return `COALESCE(u.${userFallback}, ${defaultValue})::${cast}`;
  return `${defaultValue}::${cast}`;
}

function userIdentityField(columns, columnName, defaultValue = "NULL") {
  if (hasColumn(columns, "users", columnName)) return `u.${columnName}`;
  return defaultValue;
}

function winRateExpression({ wins, losses }) {
  return `
    CASE
      WHEN (${wins} + ${losses}) > 0
        THEN ROUND((${wins} / NULLIF((${wins} + ${losses}), 0)) * 100, 2)
      ELSE 0
    END
  `;
}

function buildAllTimeConfig(category, columns) {
  const level = userStatsMetric(columns, "level", {
    userFallback: "level",
    defaultValue: "1",
    cast: "int",
  });
  const xp = userStatsMetric(columns, "xp", {
    userFallback: "xp",
    defaultValue: "0",
    cast: "int",
  });
  const totalWagered = userStatsMetric(columns, "total_wagered", {
    userFallback: "total_wagered",
  });
  const biggestWin = userStatsMetric(columns, "biggest_win", {
    userFallback: "biggest_win",
  });
  const bestStreak = userStatsMetric(columns, "best_streak", {
    userFallback: "best_streak",
    cast: "int",
  });
  const wins = userStatsMetric(columns, "wins", {
    defaultValue: "0",
    cast: "numeric",
  });
  const losses = userStatsMetric(columns, "losses", {
    defaultValue: "0",
    cast: "numeric",
  });
  const winRate = winRateExpression({ wins, losses });

  const configs = {
    level: {
      fields: `${level} AS level, ${xp} AS xp`,
      orderBy: `${level} DESC, ${xp} DESC, s.user_id ASC`,
    },
    total_wagered: {
      fields: `${totalWagered} AS total_wagered`,
      orderBy: `${totalWagered} DESC, s.user_id ASC`,
    },
    biggest_win: {
      fields: `${biggestWin} AS biggest_win`,
      orderBy: `${biggestWin} DESC, s.user_id ASC`,
    },
    best_streak: {
      fields: `${bestStreak} AS best_streak`,
      orderBy: `${bestStreak} DESC, s.user_id ASC`,
    },
    win_rate: {
      fields: `${winRate} AS win_rate, ${wins}::int AS wins, ${losses}::int AS losses`,
      orderBy: `${winRate} DESC, ${wins} DESC, s.user_id ASC`,
    },
  };

  return configs[category];
}

function buildWeeklyConfig(category, columns) {
  const weeklyLevelGain = userStatsMetric(columns, "weekly_level_gain", {
    defaultValue: "0",
    cast: "int",
  });
  const weeklyWagered = userStatsMetric(columns, "weekly_wagered", {
    userFallback: "weekly_wagered",
  });
  const weeklyBiggestWin = userStatsMetric(columns, "weekly_biggest_win", {
    userFallback: "weekly_won",
  });
  const weeklyBestStreak = userStatsMetric(columns, "weekly_best_streak", {
    defaultValue: "0",
    cast: "int",
  });
  const weeklyWins = userStatsMetric(columns, "weekly_wins", {
    userFallback: "weekly_wins",
    cast: "numeric",
  });
  const weeklyLosses = userStatsMetric(columns, "weekly_losses", {
    defaultValue: "0",
    cast: "numeric",
  });
  const weeklyWinRate = winRateExpression({
    wins: weeklyWins,
    losses: weeklyLosses,
  });

  const configs = {
    level: {
      fields: `${weeklyLevelGain} AS weekly_level_gain`,
      orderBy: `${weeklyLevelGain} DESC, s.user_id ASC`,
    },
    total_wagered: {
      fields: `${weeklyWagered} AS weekly_wagered`,
      orderBy: `${weeklyWagered} DESC, s.user_id ASC`,
    },
    biggest_win: {
      fields: `${weeklyBiggestWin} AS weekly_biggest_win`,
      orderBy: `${weeklyBiggestWin} DESC, s.user_id ASC`,
    },
    best_streak: {
      fields: `${weeklyBestStreak} AS weekly_best_streak`,
      orderBy: `${weeklyBestStreak} DESC, s.user_id ASC`,
    },
    win_rate: {
      fields: `${weeklyWinRate} AS weekly_win_rate, ${weeklyWins}::int AS weekly_wins, ${weeklyLosses}::int AS weekly_losses`,
      orderBy: `${weeklyWinRate} DESC, ${weeklyWins} DESC, s.user_id ASC`,
    },
  };

  return configs[category];
}

export function clampLeaderboardLimit(value) {
  return Math.min(100, Math.max(1, Number(value) || 20));
}

export function normalizeLeaderboardOffset(value) {
  return Math.max(0, Number(value) || 0);
}

export function normalizeLeaderboardCategory(value) {
  return LEADERBOARD_CATEGORIES.includes(value) ? value : "level";
}

async function fetchRankedRows({
  fields,
  orderBy,
  limit,
  offset,
  clerkId = null,
}) {
  const columns = await getLeaderboardColumns();
  const clerkIdField = userIdentityField(columns, "clerk_id", "NULL");
  const nameField = userIdentityField(columns, "name", "'Unknown'");
  const profilePictureField = userIdentityField(
    columns,
    "profile_picture",
    "NULL",
  );
  const params = clerkId ? [limit, offset, clerkId] : [limit, offset];
  const meClause =
    clerkId && hasColumn(columns, "users", "clerk_id")
      ? "(SELECT row_to_json(ranked) FROM ranked WHERE clerk_id = $3 LIMIT 1) AS me"
      : "NULL AS me";

  const result = await getSql().query(
    `
      WITH ranked AS (
        SELECT
          ROW_NUMBER() OVER (ORDER BY ${orderBy})::int AS rank,
          ${clerkIdField} AS clerk_id,
          s.user_id,
          ${nameField} AS name,
          ${profilePictureField} AS profile_picture,
          json_build_object(
            'name', ${nameField},
            'profile_picture', ${profilePictureField}
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

  const row = result?.[0];

  return {
    items: row?.items ?? [],
    me: row?.me ?? null,
  };
}

export async function fetchAllTimeLeaderboard({
  category,
  limit,
  offset,
  clerkId,
}) {
  const columns = await getLeaderboardColumns();
  const config = buildAllTimeConfig(
    normalizeLeaderboardCategory(category),
    columns,
  );
  return fetchRankedRows({ ...config, limit, offset, clerkId });
}

export async function fetchWeeklyLeaderboard({
  category,
  limit,
  offset,
  clerkId,
}) {
  const columns = await getLeaderboardColumns();
  const config = buildWeeklyConfig(
    normalizeLeaderboardCategory(category),
    columns,
  );
  return fetchRankedRows({ ...config, limit, offset, clerkId });
}

export async function fetchWinsLeaderboard({ limit, offset, clerkId }) {
  const columns = await getLeaderboardColumns();
  const totalWon = userStatsMetric(columns, "total_won", {
    userFallback: "total_won",
  });
  const wins = userStatsMetric(columns, "wins", {
    defaultValue: "0",
    cast: "numeric",
  });

  return fetchRankedRows({
    fields: `${totalWon} AS total_won, ${wins}::int AS wins`,
    orderBy: `${totalWon} DESC, ${wins} DESC, s.user_id ASC`,
    limit,
    offset,
    clerkId,
  });
}

/**
 * Fetch daily streak leaderboard.
 *
 * @param {'current'|'best'} type
 *   - 'current': ranks by active daily streak (daily_streak_current); resets on miss
 *   - 'best': ranks by all-time best daily streak (daily_streak_best); never decreases
 */
export async function fetchDailyStreakLeaderboard({ type, limit, offset, clerkId }) {
  const columns = await getLeaderboardColumns();

  const dailyStreakCurrent = userStatsMetric(columns, "daily_streak_current", {
    defaultValue: "0",
    cast: "int",
  });
  const dailyStreakBest = userStatsMetric(columns, "daily_streak_best", {
    defaultValue: "0",
    cast: "int",
  });

  const isCurrent = type === "current";
  const valueField = isCurrent ? dailyStreakCurrent : dailyStreakBest;
  const alias = isCurrent ? "daily_streak_current" : "daily_streak_best";

  return fetchRankedRows({
    fields: `${valueField} AS ${alias}`,
    orderBy: `${valueField} DESC, s.user_id ASC`,
    limit,
    offset,
    clerkId,
  });
}

/**
 * Fetch weekly streak leaderboard.
 *
 * @param {'weekly-current'|'weekly-best'} type
 *   - 'weekly-current': ranks by current week's daily streak (weekly_streak_current); resets every Monday
 *   - 'weekly-best': ranks by all-time best weekly streak (weekly_streak_best); never decreases
 */
export async function fetchWeeklyStreakLeaderboard({ type, limit, offset, clerkId }) {
  const columns = await getLeaderboardColumns();

  const weeklyStreakCurrent = userStatsMetric(columns, "weekly_streak_current", {
    defaultValue: "0",
    cast: "int",
  });
  const weeklyStreakBest = userStatsMetric(columns, "weekly_streak_best", {
    defaultValue: "0",
    cast: "int",
  });

  const isCurrent = type === "weekly-current";
  const valueField = isCurrent ? weeklyStreakCurrent : weeklyStreakBest;
  const alias = isCurrent ? "weekly_streak_current" : "weekly_streak_best";

  return fetchRankedRows({
    fields: `${valueField} AS ${alias}`,
    orderBy: `${valueField} DESC, s.user_id ASC`,
    limit,
    offset,
    clerkId,
  });
}
