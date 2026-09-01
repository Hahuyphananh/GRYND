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

// Game-result categories the leaderboards rank by. Tokens (total_wagered)
// and levels are intentionally absent — the boards rank skill: wins, win
// rate, games played, streaks, PvP wins and win/loss shape. `pvp_wins` is
// all-time only (there is no weekly PvP counter), so the weekly board uses
// WEEKLY_CATEGORIES below.
export const LEADERBOARD_CATEGORIES = [
  "wins",
  "win_rate",
  "games",
  "best_streak",
  "pvp_wins",
  "net_wins",
  "win_loss_ratio",
  "current_streak",
  "biggest_win",
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
  const biggestWin = userStatsMetric(columns, "biggest_win", {
    userFallback: "biggest_win",
    defaultValue: "0",
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
    biggest_win: {
      fields: `${miniStats}, ${biggestWin} AS biggest_win`,
      orderBy: `${biggestWin} DESC, s.user_id ASC`,
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
  const weeklyBiggestWin = userStatsMetric(columns, "weekly_biggest_win", {
    userFallback: "weekly_won",
    defaultValue: "0",
  });

  const netWins = `(${weeklyWins}::int - ${weeklyLosses}::int)`;
  const winLossRatio = `
    CASE
      WHEN ${weeklyLosses} > 0 THEN ROUND((${weeklyWins} / ${weeklyLosses})::numeric, 2)
      WHEN ${weeklyWins} > 0 THEN ${weeklyWins}
      ELSE 0
    END
  `;

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
    biggest_win: {
      fields: `${miniStats}, ${weeklyBiggestWin} AS weekly_biggest_win`,
      orderBy: `${weeklyBiggestWin} DESC, s.user_id ASC`,
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
          json_build_object(
            'name', ${nameField},
            'icon_key', ${iconKeyField}
          ) AS "user",
          ${fields}
        FROM user_stats s
        INNER JOIN users u ON u.id = s.user_id
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
    normalizeWeeklyLeaderboardCategory(category),
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

// ── Per-game leaderboards ───────────────────────────────────────────
// "Best player per game", computed directly from the game tables. Each
// game contributes a `playedSql` snippet producing (clerk_id, wins,
// losses) using the same win/loss definition the platform's stats use:
// solo games win when payout > bet; PvP matches win/lose by the match's
// winner column (draws count as neither). Wins/losses per player are then
// ranked + joined to `users` by fetchGameBoard().

function soloIntGameSql(table, payoutExpr = "g.payout", betExpr = "g.bet_amount") {
  return `
    SELECT u.clerk_id AS clerk_id,
      COUNT(*) FILTER (WHERE ${payoutExpr} > ${betExpr})::int AS wins,
      COUNT(*) FILTER (WHERE ${payoutExpr} < ${betExpr})::int AS losses
    FROM ${table} g
    INNER JOIN users u ON u.id = g.user_id
    GROUP BY u.clerk_id
  `;
}

function soloClerkGameSql(table, payoutExpr = "g.payout", betExpr = "g.bet_amount") {
  return `
    SELECT u.clerk_id AS clerk_id,
      COUNT(*) FILTER (WHERE ${payoutExpr} > ${betExpr})::int AS wins,
      COUNT(*) FILTER (WHERE ${payoutExpr} < ${betExpr})::int AS losses
    FROM ${table} g
    INNER JOIN users u ON u.clerk_id = g.user_id
    GROUP BY u.clerk_id
  `;
}

function pvpWinnerIdSql(table, p1, p2, winner) {
  return `
    SELECT player AS clerk_id,
      COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
      COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses
    FROM (
      SELECT ${p1} AS player,
        CASE WHEN ${winner} = ${p1} THEN 'win'
             WHEN ${winner} IS NOT NULL AND ${winner} <> ${p1} THEN 'loss'
        END AS outcome
      FROM ${table}
      UNION ALL
      SELECT ${p2},
        CASE WHEN ${winner} = ${p2} THEN 'win'
             WHEN ${winner} IS NOT NULL AND ${winner} <> ${p2} THEN 'loss'
        END
      FROM ${table}
    ) plays
    WHERE player IS NOT NULL AND outcome IS NOT NULL
    GROUP BY player
  `;
}

function pvpSideWinnerSql(table, p1, p2, winner, extraWhere = "") {
  const where = extraWhere ? ` WHERE ${extraWhere}` : "";
  return `
    SELECT player AS clerk_id,
      COUNT(*) FILTER (WHERE outcome = 'win')::int AS wins,
      COUNT(*) FILTER (WHERE outcome = 'loss')::int AS losses
    FROM (
      SELECT ${p1} AS player,
        CASE WHEN ${winner} = 'player1' THEN 'win'
             WHEN ${winner} = 'player2' THEN 'loss'
        END AS outcome
      FROM ${table}${where}
      UNION ALL
      SELECT ${p2},
        CASE WHEN ${winner} = 'player2' THEN 'win'
             WHEN ${winner} = 'player1' THEN 'loss'
        END
      FROM ${table}${where}
    ) plays
    WHERE player IS NOT NULL AND outcome IS NOT NULL
    GROUP BY player
  `;
}

/** Ordered list of games with a per-game leaderboard (first = default). */
export const GAME_LEADERBOARD_KEYS = [
  "chess",
  "four-in-a-row",
  "plinko",
  "roulette",
  "blackjack",
  "mines",
  "rps",
  "uno",
  "keno",
  "crash",
  "keno-duel",
  "mines-pvp",
  "lane-rush",
  "memory-grid",
  "dice",
  "pool",
  "hex-duel",
  "odds",
];

const GAME_LEADERBOARDS = {
  chess: {
    label: "Chess",
    playedSql: pvpWinnerIdSql(
      "chess_games",
      "player_white_id",
      "player_black_id",
      "winner_id",
    ),
  },
  "four-in-a-row": {
    label: "Four In A Row",
    playedSql: pvpWinnerIdSql(
      "four_in_a_row_games",
      "host_clerk_id",
      "guest_clerk_id",
      "winner_clerk_id",
    ),
  },
  plinko: { label: "Plinko", playedSql: soloClerkGameSql("plinko_games") },
  roulette: { label: "Roulette", playedSql: soloIntGameSql("roulette_games") },
  blackjack: { label: "Blackjack", playedSql: soloIntGameSql("blackjack_games") },
  mines: { label: "Mines", playedSql: soloIntGameSql("mines_games") },
  rps: { label: "RPS", playedSql: soloClerkGameSql("rps_games") },
  // UNO stores bet/payout as text — cast to compare numerically.
  uno: {
    label: "UNO",
    playedSql: soloIntGameSql(
      "uno_games",
      "g.payout::numeric",
      "g.bet_amount::numeric",
    ),
  },
  keno: { label: "Keno", playedSql: soloIntGameSql("keno_games") },
  crash: { label: "Crash", playedSql: soloIntGameSql("crash_games") },
  "keno-duel": {
    label: "Keno Duel",
    playedSql: pvpWinnerIdSql("keno_pvp_matches", "player1_id", "player2_id", "winner_id"),
  },
  "mines-pvp": {
    label: "Mines PvP",
    playedSql: pvpWinnerIdSql("mines_pvp_matches", "player1_id", "player2_id", "winner_id"),
  },
  "lane-rush": {
    label: "Lane Rush Duel",
    playedSql: pvpWinnerIdSql("lane_rush_duel_matches", "player1_id", "player2_id", "winner_id"),
  },
  "memory-grid": {
    label: "Memory Grid",
    playedSql: pvpWinnerIdSql("memory_grid_matches", "player1_id", "player2_id", "winner_id"),
  },
  dice: {
    label: "Dice",
    playedSql: pvpWinnerIdSql("dice_matches", "player1_id", "player2_id", "winner_id"),
  },
  pool: {
    label: "Pool Masters",
    playedSql: pvpWinnerIdSql("pool_matches", "player1_id", "player2_id", "winner_id"),
  },
  // Hex Duel uses a 'player1'/'player2' winner string; fun mode moves no
  // tokens and is excluded (mirrors the profile-stats route).
  "hex-duel": {
    label: "Hex Duel",
    playedSql: pvpSideWinnerSql(
      "hex_duel_games",
      "player1_id",
      "player2_id",
      "winner",
      "is_fun_mode = false",
    ),
  },
  odds: {
    label: "Odds",
    playedSql: pvpSideWinnerSql("odds_games", "player1_id", "player2_id", "winner"),
  },
};

/** Display label for a game leaderboard key (falls back to "Game"). */
export function getGameLeaderboardLabel(game) {
  return GAME_LEADERBOARDS[game]?.label ?? "Game";
}

/** Coerce a ?game= value to a known game key (defaults to the first). */
export function normalizeGameKey(value) {
  return GAME_LEADERBOARD_KEYS.includes(value)
    ? value
    : GAME_LEADERBOARD_KEYS[0];
}

/**
 * Rank players by wins in a single game (computed from the game tables).
 * Returns the same { items, me } shape as the other boards, with a
 * per-game W/L record (wins, losses, win_rate, games) per row.
 */
export async function fetchGameLeaderboard({ game, limit, offset, clerkId }) {
  const key = normalizeGameKey(game);
  const config = GAME_LEADERBOARDS[key];
  const columns = await getLeaderboardColumns();
  const nameField = userIdentityField(columns, "name", "'Unknown'");
  const iconKeyField = userIdentityField(columns, "selected_icon", "NULL");
  const params = clerkId ? [limit, offset, clerkId] : [limit, offset];
  const meClause =
    clerkId && hasColumn(columns, "users", "clerk_id")
      ? "(SELECT row_to_json(ranked) FROM ranked WHERE clerk_id = $3 LIMIT 1) AS me"
      : "NULL AS me";

  const result = await getSql().query(
    `
      WITH played AS (
        ${config.playedSql}
      ),
      ranked AS (
        SELECT
          ROW_NUMBER() OVER (ORDER BY played.wins DESC, played.losses ASC, played.clerk_id ASC)::int AS rank,
          played.clerk_id,
          ${nameField} AS name,
          ${iconKeyField} AS icon_key,
          json_build_object(
            'name', ${nameField},
            'icon_key', ${iconKeyField}
          ) AS "user",
          played.wins,
          played.losses,
          CASE
            WHEN (played.wins + played.losses) > 0
              THEN ROUND((played.wins::numeric / (played.wins + played.losses)) * 100, 2)
            ELSE 0
          END AS win_rate,
          (played.wins + played.losses) AS games
        FROM played
        INNER JOIN users u ON u.clerk_id = played.clerk_id
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
