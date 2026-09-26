import { getNeonSql } from "../db/neon";
import { getFrameDecorations } from "./cosmetics";
import { OVERALL_MIN_GAMES, PROVISIONAL_GAMES } from "./elo";

// Reusable SQL for the Overall Elo badge shown next to a player's name on
// every board. It is the SAME aggregate the Overall leaderboard ranks by —
// the mean of a player's ESTABLISHED game ratings, present only with at least
// OVERALL_MIN_GAMES different established games — so the badge and the board
// can never disagree. Derived on read; nothing is stored.
const OVERALL_ELO_JOIN = `
  LEFT JOIN (
    SELECT r.user_id,
           ROUND(AVG(r.rating))::int AS overall_elo,
           COUNT(*)::int AS overall_games
    FROM player_ratings r
    WHERE r.games_rated >= ${PROVISIONAL_GAMES}
    GROUP BY r.user_id
    HAVING COUNT(*) >= ${OVERALL_MIN_GAMES}
  ) o ON o.user_id = s.user_id
`;

/**
 * Attach the Overall Elo badge to a board row. Raw snake_case columns never
 * leave the server: a row without an aggregate simply omits `overallElo`.
 */
function decorateOverallElo(item) {
  if (!item) return item;
  const { overall_elo, overall_games, ...rest } = item;
  const elo = Number(overall_elo);
  if (!Number.isFinite(elo) || elo <= 0) return rest;
  return { ...rest, overallElo: elo, overallGames: Number(overall_games) || 0 };
}

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

// Game-result categories the leaderboards rank by. Every token-derived
// metric (total_wagered, total_won, biggest_win) and levels are deliberately
// absent — the boards rank skill: wins, win rate, games played, streaks, PvP
// wins and win/loss shape. `pvp_wins` is all-time only (there is no weekly
// PvP counter), so the weekly board uses WEEKLY_CATEGORIES below.
//
// GAME-SPECIFIC boards are NOT in this list. Each rated game has its own Elo
// board (fetchRatingLeaderboard in src/lib/rating.js) sorted by that game's
// current rating — see how the previous wins/payout-based per-game boards
// were replaced in migration-era commit history and the note further down.
export const LEADERBOARD_CATEGORIES = [
  "wins",
  "win_rate",
  "games",
  "best_streak",
  "pvp_wins",
  "net_wins",
  "win_loss_ratio",
  "current_streak",
];

/** Categories the weekly board supports (no all-time-only pvp_wins). */
export const WEEKLY_CATEGORIES = LEADERBOARD_CATEGORIES.filter(
  (c) => c !== "pvp_wins",
);

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

/**
 * W/L record + current game streak fields (all-time), returned with every
 * board — weekly/all-time categories and the streak tabs — so the UI can
 * render "12W · 5L · 71% · 17 games · 3 streak" under the player's name
 * on every row.
 */
function allTimeMiniStatsFields(columns) {
  const wins = userStatsMetric(columns, "wins", {
    defaultValue: "0",
    cast: "numeric",
  });
  const losses = userStatsMetric(columns, "losses", {
    defaultValue: "0",
    cast: "numeric",
  });
  const games = userStatsMetric(columns, "total_bets", {
    defaultValue: "0",
    cast: "int",
  });
  const winRate = winRateExpression({ wins, losses });
  const currentStreak = userStatsMetric(columns, "current_streak", {
    defaultValue: "0",
    cast: "int",
  });
  return `
    ${wins}::int AS wins,
    ${losses}::int AS losses,
    ${winRate} AS win_rate,
    ${games} AS games,
    ${currentStreak} AS current_streak
  `;
}

/** Weekly equivalents of the mini-stats above (games = wins + losses). */
function weeklyMiniStatsFields(columns) {
  const weeklyWins = userStatsMetric(columns, "weekly_wins", {
    userFallback: "weekly_wins",
    defaultValue: "0",
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
  const weeklyGames = `(${weeklyWins}::int + ${weeklyLosses}::int)`;
  const weeklyCurrentStreak = userStatsMetric(columns, "weekly_game_streak", {
    defaultValue: "0",
    cast: "int",
  });
  return `
    ${weeklyWins}::int AS weekly_wins,
    ${weeklyLosses}::int AS weekly_losses,
    ${weeklyWinRate} AS weekly_win_rate,
    ${weeklyGames} AS weekly_games,
    ${weeklyCurrentStreak} AS weekly_current_streak
  `;
}

/**
 * Build the all-time (cumulative) leaderboard config for a category.
 * Every config also returns the W/L mini-stats so the UI can render a
 * record line on every row regardless of what the board ranks by.
 */
function buildAllTimeConfig(category, columns) {
  const wins = userStatsMetric(columns, "wins", {
    defaultValue: "0",
    cast: "numeric",
  });
  const losses = userStatsMetric(columns, "losses", {
    defaultValue: "0",
    cast: "numeric",
  });
  const bestStreak = userStatsMetric(columns, "best_streak", {
    userFallback: "best_streak",
    defaultValue: "0",
    cast: "int",
  });
  const pvpWins = userStatsMetric(columns, "pvp_wins", {
    userFallback: "pvp_wins",
    defaultValue: "0",
    cast: "int",
  });

  const netWins = `(${wins}::int - ${losses}::int)`;
  const winLossRatio = `
    CASE
      WHEN ${losses} > 0 THEN ROUND((${wins} / ${losses})::numeric, 2)
      WHEN ${wins} > 0 THEN ${wins}
      ELSE 0
    END
  `;
  const games = userStatsMetric(columns, "total_bets", {
    defaultValue: "0",
    cast: "int",
  });
  const winRate = winRateExpression({ wins, losses });
  const currentStreak = userStatsMetric(columns, "current_streak", {
    defaultValue: "0",
    cast: "int",
  });

  const miniStats = allTimeMiniStatsFields(columns);
  const configs = {
    wins: {
      fields: miniStats,
      orderBy: `${wins} DESC, ${losses} ASC, s.user_id ASC`,
    },
    win_rate: {
      fields: miniStats,
      orderBy: `${winRate} DESC, ${wins} DESC, s.user_id ASC`,
      // A 1-0 record is not a win rate — require a real sample size.
      whereClause: `${wins} + ${losses} >= 10`,
    },
    games: {
      fields: miniStats,
      orderBy: `${games} DESC, s.user_id ASC`,
    },
    best_streak: {
      fields: `${miniStats}, ${bestStreak} AS best_streak`,
      orderBy: `${bestStreak} DESC, s.user_id ASC`,
    },
    pvp_wins: {
      fields: `${miniStats}, ${pvpWins} AS pvp_wins`,
      orderBy: `${pvpWins} DESC, s.user_id ASC`,
    },
    net_wins: {
      fields: `${miniStats}, ${netWins} AS net_wins`,
      orderBy: `${netWins} DESC, ${wins} DESC, s.user_id ASC`,
    },
    win_loss_ratio: {
      fields: `${miniStats}, ${winLossRatio} AS win_loss_ratio`,
      orderBy: `${winLossRatio} DESC, ${wins} DESC, s.user_id ASC`,
    },
    current_streak: {
      fields: miniStats,
      orderBy: `${currentStreak} DESC, s.user_id ASC`,
    },
  };

  return configs[category];
}

/**
 * Build the weekly (Monday-reset) leaderboard config. Same categories as
 * all-time except `pvp_wins` (no weekly PvP counter exists), and games
 * played is computed as weekly wins + weekly losses (no weekly bet
 * counter). Mini-stats are the weekly equivalents.
 */
function buildWeeklyConfig(category, columns) {
  const weeklyWins = userStatsMetric(columns, "weekly_wins", {
    userFallback: "weekly_wins",
    defaultValue: "0",
    cast: "numeric",
  });
  const weeklyLosses = userStatsMetric(columns, "weekly_losses", {
    defaultValue: "0",
    cast: "numeric",
  });
  const weeklyBestStreak = userStatsMetric(columns, "weekly_best_streak", {
    defaultValue: "0",
    cast: "int",
  });
  const netWins = `(${weeklyWins}::int - ${weeklyLosses}::int)`;
  const winLossRatio = `
    CASE
      WHEN ${weeklyLosses} > 0 THEN ROUND((${weeklyWins} / ${weeklyLosses})::numeric, 2)
      WHEN ${weeklyWins} > 0 THEN ${weeklyWins}
      ELSE 0
    END
  `;
  const weeklyGames = `(${weeklyWins}::int + ${weeklyLosses}::int)`;
  const weeklyWinRate = winRateExpression({
    wins: weeklyWins,
    losses: weeklyLosses,
  });
  const weeklyCurrentStreak = userStatsMetric(columns, "weekly_game_streak", {
    defaultValue: "0",
    cast: "int",
  });

  const miniStats = weeklyMiniStatsFields(columns);
  const configs = {
    wins: {
      fields: miniStats,
      orderBy: `${weeklyWins} DESC, ${weeklyLosses} ASC, s.user_id ASC`,
    },
    win_rate: {
      fields: miniStats,
      orderBy: `${weeklyWinRate} DESC, ${weeklyWins} DESC, s.user_id ASC`,
      whereClause: `${weeklyWins} + ${weeklyLosses} >= 5`,
    },
    games: {
      fields: miniStats,
      orderBy: `${weeklyGames} DESC, s.user_id ASC`,
    },
    best_streak: {
      fields: `${miniStats}, ${weeklyBestStreak} AS weekly_best_streak`,
      orderBy: `${weeklyBestStreak} DESC, s.user_id ASC`,
    },
    net_wins: {
      fields: `${miniStats}, ${netWins} AS weekly_net_wins`,
      orderBy: `${netWins} DESC, ${weeklyWins} DESC, s.user_id ASC`,
    },
    win_loss_ratio: {
      fields: `${miniStats}, ${winLossRatio} AS weekly_win_loss_ratio`,
      orderBy: `${winLossRatio} DESC, ${weeklyWins} DESC, s.user_id ASC`,
    },
    current_streak: {
      fields: miniStats,
      orderBy: `${weeklyCurrentStreak} DESC, s.user_id ASC`,
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
  return LEADERBOARD_CATEGORIES.includes(value) ? value : "wins";
}

/** Weekly-safe category normalization (no all-time-only pvp_wins). */
export function normalizeWeeklyLeaderboardCategory(value) {
  return WEEKLY_CATEGORIES.includes(value) ? value : "wins";
}

/**
 * Server-authoritative prestige badge decoration for a leaderboard row.
 * The raw prestige columns never leave this module — only the resolved
 * label (or nothing) is returned, so a client can never render an unearned
 * badge. Shared by every board (stats boards + per-game boards).
 */
function decoratePrestigeBadge(item) {
  if (!item) return item;
  const { show_prestige_badge, best_prestige, ...rest } = item;
  // Prestige is DERIVED (max(0, elo−1000) for a game whose trophies reached
  // the per-game cap) and computed in SQL by the lateral join below, so the raw
  // columns never leave the server — only the resolved label does. Same label
  // format as resolvePrestigeBadge in src/lib/prestige.js.
  const prestige = Number(best_prestige);
  if (show_prestige_badge === true && Number.isFinite(prestige) && prestige >= 1) {
    return { ...rest, prestigeBadge: `Prestige ${prestige}` };
  }
  return rest;
}

/**
 * Attach each row's equipped profile frame (server-owned name + visual) and
 * drop the raw `equipped_cosmetics` map so it never leaves the server. One
 * catalog query decorates the whole page (see src/lib/cosmetics.ts).
 */
async function attachProfileFrames(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return list;
  const decorations = await getFrameDecorations(
    list.map((item) => item?.equipped_cosmetics),
  );
  return list.map((item, index) => {
    if (!item) return item;
    const { equipped_cosmetics, ...rest } = item;
    const decoration = decorations[index];
    return decoration ? { ...rest, profileFrame: decoration } : rest;
  });
}

async function fetchRankedRows({
  fields,
  orderBy,
  whereClause = "",
  limit,
  offset,
  clerkId = null,
}) {
  const columns = await getLeaderboardColumns();
  const clerkIdField = userIdentityField(columns, "clerk_id", "NULL");
  const nameField = userIdentityField(columns, "name", "'Unknown'");
  const iconKeyField = userIdentityField(columns, "selected_icon", "NULL");
  // Prestige opt-in — guarded by the introspection so boards keep working on
  // databases that predate migration 0137. The value itself is derived in SQL
  // below from the player_trophies + player_ratings rows (no prestige column
  // exists any more).
  const showPrestigeBadgeField = userIdentityField(
    columns,
    "show_prestige_badge",
    "false",
  );
  const equippedField = userIdentityField(columns, "equipped_cosmetics", "NULL");
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
          ${iconKeyField} AS icon_key,
          ${showPrestigeBadgeField} AS show_prestige_badge,
          p.best_prestige AS best_prestige,
          ${equippedField} AS equipped_cosmetics,
          o.overall_elo AS overall_elo,
          COALESCE(o.overall_games, 0) AS overall_games,
          json_build_object(
            'name', ${nameField},
            'icon_key', ${iconKeyField}
          ) AS "user",
          ${fields}
        FROM user_stats s
        INNER JOIN users u ON u.id = s.user_id
        ${OVERALL_ELO_JOIN}
        -- Derived Prestige: the highest (rating − 1000) among the player's
        -- games whose trophies have reached the per-game cap, or NULL. Same
        -- definition as bestPrestige in src/lib/prestige.js, so the board
        -- badge and the profile can never disagree.
        LEFT JOIN LATERAL (
          SELECT MAX(pr.rating - 1000)::int AS best_prestige
          FROM player_trophies t
          INNER JOIN player_ratings pr
            ON pr.user_id = t.user_id AND pr.game_key = t.game_key
          WHERE t.user_id = s.user_id
            AND t.trophies >= 10000
            AND pr.rating > 1000
        ) p ON true
        ${whereClause ? `WHERE ${whereClause}` : ""}
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

  const decorate = (item) => decoratePrestigeBadge(decorateOverallElo(item));
  const items = Array.isArray(row?.items) ? row.items.map(decorate) : [];
  const me = row?.me ? decorate(row.me) : null;

  return {
    items: await attachProfileFrames(items),
    me: me ? (await attachProfileFrames([me]))[0] : null,
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
    normalizeWeeklyLeaderboardCategory(category),
    columns,
  );
  return fetchRankedRows({ ...config, limit, offset, clerkId });
}

// NOTE: the old `fetchWinsLeaderboard` (a cross-game board ordered by
// `total_won` — tokens won) was removed with the token economy. There is no
// "overall" Elo board to replace it with by design: every competitive board
// is per game (see fetchRatingLeaderboard in src/lib/rating.js).

// ── Game-specific boards ────────────────────────────────────────────
// There is deliberately NO wins/payout-based per-game board in this module
// any more. The boards that used to live here were either solo wager games
// (win = `payout > bet`, a token metric) or PvP games ranked by a raw win
// count that ignored opponent strength.
//
// Each RATED game now has its own GAME-SPECIFIC ELO board, sorted by the
// player's current rating in that game and served by
//   GET /api/leaderboard/game?game=<key>
// implemented with fetchRatingLeaderboard in src/lib/rating.js, so the
// ratings and their leaderboards share exactly one source of truth.
// Provisional players are returned with `provisional: true` plus their
// completed/remaining placement matches so the board can label them.
// There is no combined / "overall" Elo board by design.



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

  // Also return the all-time W/L record so streak rows can show the
  // player's game record under their name.
  return fetchRankedRows({
    fields: `${allTimeMiniStatsFields(columns)}, ${valueField} AS ${alias}`,
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

  // Also return the all-time W/L record so streak rows can show the
  // player's game record under their name.
  return fetchRankedRows({
    fields: `${allTimeMiniStatsFields(columns)}, ${valueField} AS ${alias}`,
    orderBy: `${valueField} DESC, s.user_id ASC`,
    limit,
    offset,
    clerkId,
  });
}
