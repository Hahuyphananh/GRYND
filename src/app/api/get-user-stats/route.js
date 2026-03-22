import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../db";

const TRACKED_GAMES = [
  {
    key: "roulette",
    label: "Roulette",
    table: "roulette_games",
    userColumn: "user_id",
    betColumn: "bet_amount",
    payoutColumn: "payout",
  },
  {
    key: "blackjack",
    label: "Blackjack",
    table: "blackjack_games",
    userColumn: "user_id",
    betColumn: "bet_amount",
    payoutColumn: "payout",
  },
  {
    key: "crash",
    label: "Crash",
    table: "crash_games",
    userColumn: "user_id",
    betColumn: "bet_amount",
    payoutColumn: "payout",
  },
  {
    key: "mines",
    label: "Mines",
    table: "mines_games",
    userColumn: "user_id",
    betColumn: "bet_amount",
    payoutColumn: "payout",
  },
  {
    key: "keno",
    label: "Keno",
    table: "keno_games",
    userColumn: "user_id",
    betColumn: "bet_amount",
    payoutColumn: "payout",
  },
];

const gameStatsUnion = TRACKED_GAMES.map(
  (game) => `
    SELECT
      '${game.key}'::text AS game_key,
      '${game.label}'::text AS game_label,
      ${game.userColumn}::int AS user_id,
      COALESCE(${game.betColumn}::numeric, 0) AS amount_lost,
      COALESCE(${game.payoutColumn}::numeric, 0) AS amount_won,
      CASE WHEN COALESCE(${game.payoutColumn}::numeric, 0) > COALESCE(${game.betColumn}::numeric, 0) THEN 1 ELSE 0 END AS games_won,
      CASE WHEN COALESCE(${game.payoutColumn}::numeric, 0) < COALESCE(${game.betColumn}::numeric, 0) THEN 1 ELSE 0 END AS games_lost
    FROM ${game.table}
  `
).join(" UNION ALL ");

export async function GET() {
  try {
    const query = sql.raw(`
      WITH game_entries AS (
        ${gameStatsUnion}
      ),
      overall_totals AS (
        SELECT
          user_id,
          COALESCE(SUM(amount_won), 0) AS amount_won,
          COALESCE(SUM(amount_lost), 0) AS amount_lost
        FROM game_entries
        GROUP BY user_id
      ),
      game_totals AS (
        SELECT
          game_key,
          game_label,
          user_id,
          COALESCE(SUM(amount_won), 0) AS amount_won,
          COALESCE(SUM(amount_lost), 0) AS amount_lost,
          COALESCE(SUM(games_won), 0) AS games_won,
          COALESCE(SUM(games_lost), 0) AS games_lost
        FROM game_entries
        GROUP BY game_key, game_label, user_id
      )
      SELECT
        'overall'::text AS scope,
        NULL::text AS game_key,
        NULL::text AS game_label,
        u.id AS user_id,
        u.name,
        COALESCE(u.games_won, 0) AS games_won,
        COALESCE(u.games_lost, 0) AS games_lost,
        COALESCE(o.amount_won, 0) AS amount_won,
        COALESCE(o.amount_lost, 0) AS amount_lost
      FROM users u
      LEFT JOIN overall_totals o ON o.user_id = u.id

      UNION ALL

      SELECT
        'game'::text AS scope,
        gt.game_key,
        gt.game_label,
        u.id AS user_id,
        u.name,
        gt.games_won,
        gt.games_lost,
        gt.amount_won,
        gt.amount_lost
      FROM game_totals gt
      JOIN users u ON u.id = gt.user_id;
    `);

    const { rows } = await db.execute(query);

    const overallUsers = rows
      .filter((row) => row.scope === "overall")
      .map((row) => {
        const gamesWon = Number(row.games_won ?? 0);
        const gamesLost = Number(row.games_lost ?? 0);
        const amountWon = Number(row.amount_won ?? 0);
        const amountLost = Number(row.amount_lost ?? 0);

        return {
          name: row.name,
          gamesWon,
          gamesLost,
          amountWon,
          amountLost,
          totalProfit: amountWon - amountLost,
          netGames: gamesWon - gamesLost,
        };
      })
      .sort((a, b) => b.netGames - a.netGames)
      .map((user, index) => ({
        rank: index + 1,
        ...user,
      }));

    const gameRows = rows.filter((row) => row.scope === "game");
    const groupedGameRows = gameRows.reduce((acc, row) => {
      const gameKey = row.game_key;
      if (!acc[gameKey]) {
        acc[gameKey] = {
          gameLabel: row.game_label,
          players: [],
        };
      }

      const gamesWon = Number(row.games_won ?? 0);
      const gamesLost = Number(row.games_lost ?? 0);
      const amountWon = Number(row.amount_won ?? 0);
      const amountLost = Number(row.amount_lost ?? 0);
      const totalGames = gamesWon + gamesLost;
      const winRate = totalGames > 0 ? (gamesWon / totalGames) * 100 : 0;

      acc[gameKey].players.push({
        name: row.name,
        gamesWon,
        gamesLost,
        amountWon,
        amountLost,
        totalProfit: amountWon - amountLost,
        netGames: gamesWon - gamesLost,
        winRate,
      });

      return acc;
    }, {});

    const gameLeaderboards = Object.fromEntries(
      Object.entries(groupedGameRows).map(([gameKey, gameData]) => {
        const rankedPlayers = gameData.players
          .sort((a, b) => {
            if (b.winRate !== a.winRate) return b.winRate - a.winRate;
            if (b.netGames !== a.netGames) return b.netGames - a.netGames;
            return b.totalProfit - a.totalProfit;
          })
          .map((player, index) => ({
            rank: index + 1,
            ...player,
          }));

        return [
          gameKey,
          {
            gameLabel: gameData.gameLabel,
            players: rankedPlayers,
          },
        ];
      })
    );

    return NextResponse.json({
      success: true,
      users: overallUsers,
      games: gameLeaderboards,
    });
  } catch (error) {
    console.error("Error fetching user stats:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch user stats" },
      { status: 500 }
    );
  }
}
