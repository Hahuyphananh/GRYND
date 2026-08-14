import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../db";

const TRACKED_GAMES = [
  {
    key: "roulette",
    label: "Roulette",
    selectSql: `
      SELECT
        'roulette'::text AS game_key,
        'Roulette'::text AS game_label,
        rg.user_id::int AS user_id,
        COALESCE(rg.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(rg.payout::numeric, 0) AS amount_won,
        CASE WHEN COALESCE(rg.payout::numeric, 0) > COALESCE(rg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_won,
        CASE WHEN COALESCE(rg.payout::numeric, 0) < COALESCE(rg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_lost
      FROM roulette_games rg
    `,
  },
  {
    key: "blackjack",
    label: "Blackjack",
    selectSql: `
      SELECT
        'blackjack'::text AS game_key,
        'Blackjack'::text AS game_label,
        bg.user_id::int AS user_id,
        COALESCE(bg.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(bg.payout::numeric, 0) AS amount_won,
        CASE WHEN COALESCE(bg.payout::numeric, 0) > COALESCE(bg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_won,
        CASE WHEN COALESCE(bg.payout::numeric, 0) < COALESCE(bg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_lost
      FROM blackjack_games bg
    `,
  },
  {
    key: "crash",
    label: "Crash",
    selectSql: `
      SELECT
        'crash'::text AS game_key,
        'Crash'::text AS game_label,
        cg.user_id::int AS user_id,
        COALESCE(cg.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(cg.payout::numeric, 0) AS amount_won,
        CASE WHEN COALESCE(cg.payout::numeric, 0) > COALESCE(cg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_won,
        CASE WHEN COALESCE(cg.payout::numeric, 0) < COALESCE(cg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_lost
      FROM crash_games cg
    `,
  },
  {
    key: "mines",
    label: "Mines",
    selectSql: `
      SELECT
        'mines'::text AS game_key,
        'Mines'::text AS game_label,
        mg.user_id::int AS user_id,
        COALESCE(mg.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(mg.payout::numeric, 0) AS amount_won,
        CASE WHEN COALESCE(mg.payout::numeric, 0) > COALESCE(mg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_won,
        CASE WHEN COALESCE(mg.payout::numeric, 0) < COALESCE(mg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_lost
      FROM mines_games mg
    `,
  },
  {
    key: "keno",
    label: "Keno",
    selectSql: `
      SELECT
        'keno'::text AS game_key,
        'Keno'::text AS game_label,
        kg.user_id::int AS user_id,
        COALESCE(kg.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(kg.payout::numeric, 0) AS amount_won,
        CASE WHEN COALESCE(kg.payout::numeric, 0) > COALESCE(kg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_won,
        CASE WHEN COALESCE(kg.payout::numeric, 0) < COALESCE(kg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_lost
      FROM keno_games kg
    `,
  },
  {
    key: "chess",
    label: "Chess",
    selectSql: `
      SELECT
        'chess'::text AS game_key,
        'Chess'::text AS game_label,
        ux.id AS user_id,
        COALESCE(cg.bet_amount::numeric, 0) AS amount_lost,
        CASE
          WHEN cg.winner_id = cg.player_white_id THEN COALESCE(cg.payout::numeric, COALESCE(cg.bet_amount::numeric, 0) * 2)
          WHEN cg.winner_id IS NULL THEN COALESCE(cg.bet_amount::numeric, 0)
          ELSE 0
        END AS amount_won,
        CASE WHEN cg.winner_id = cg.player_white_id THEN 1 ELSE 0 END AS games_won,
        CASE WHEN cg.winner_id IS NOT NULL AND cg.winner_id <> cg.player_white_id THEN 1 ELSE 0 END AS games_lost
      FROM chess_games cg
      JOIN users ux ON ux.clerk_id = cg.player_white_id

      UNION ALL

      SELECT
        'chess'::text AS game_key,
        'Chess'::text AS game_label,
        ub.id AS user_id,
        COALESCE(cg.bet_amount::numeric, 0) AS amount_lost,
        CASE
          WHEN cg.winner_id = cg.player_black_id THEN COALESCE(cg.payout::numeric, COALESCE(cg.bet_amount::numeric, 0) * 2)
          WHEN cg.winner_id IS NULL THEN COALESCE(cg.bet_amount::numeric, 0)
          ELSE 0
        END AS amount_won,
        CASE WHEN cg.winner_id = cg.player_black_id THEN 1 ELSE 0 END AS games_won,
        CASE WHEN cg.winner_id IS NOT NULL AND cg.winner_id <> cg.player_black_id THEN 1 ELSE 0 END AS games_lost
      FROM chess_games cg
      JOIN users ub ON ub.clerk_id = cg.player_black_id
      WHERE cg.player_black_id IS NOT NULL
    `,
  },
  {
    key: "plinko",
    label: "Plinko",
    selectSql: `
      SELECT
        'plinko'::text AS game_key,
        'Plinko'::text AS game_label,
        u.id AS user_id,
        (COALESCE(pg.bet_amount::numeric, 0) / cnt.ball_count) AS amount_lost,
        (COALESCE(pg.bet_amount::numeric, 0) / cnt.ball_count) * mult.multiplier AS amount_won,
        CASE WHEN mult.multiplier > 1 THEN 1 ELSE 0 END AS games_won,
        CASE WHEN mult.multiplier < 1 THEN 1 ELSE 0 END AS games_lost
      FROM plinko_games pg
      JOIN users u ON u.clerk_id = pg.user_id
      CROSS JOIN LATERAL (
        SELECT NULLIF(array_length(string_to_array(pg.result_multiplier, ','), 1), 0)::numeric AS ball_count
      ) cnt
      CROSS JOIN LATERAL (
        SELECT TRIM(value)::numeric AS multiplier
        FROM unnest(string_to_array(pg.result_multiplier, ',')) AS value
        WHERE TRIM(value) ~ '^-?[0-9]+(\\.[0-9]+)?$'
      ) mult
      WHERE cnt.ball_count IS NOT NULL
        AND mult.multiplier <> 1
    `,
  },
  {
    key: "poker",
    label: "Poker",
    selectSql: `
      SELECT
        'poker'::text AS game_key,
        'Poker'::text AS game_label,
        pg.user_id::int AS user_id,
        COALESCE(pg.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(pg.payout::numeric, 0) AS amount_won,
        CASE WHEN COALESCE(pg.payout::numeric, 0) > COALESCE(pg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_won,
        CASE WHEN COALESCE(pg.payout::numeric, 0) < COALESCE(pg.bet_amount::numeric, 0) THEN 1 ELSE 0 END AS games_lost
      FROM poker_games pg
    `,
  },
  {
    key: "uno",
    label: "Uno",
    selectSql: `
      SELECT
        'uno'::text AS game_key,
        'Uno'::text AS game_label,
        ug.user_id::int AS user_id,
        COALESCE(ug.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(ug.payout::numeric, 0) AS amount_won,
        CASE WHEN LOWER(COALESCE(ug.result, '')) IN ('win', 'won') THEN 1 ELSE 0 END AS games_won,
        CASE WHEN LOWER(COALESCE(ug.result, '')) IN ('lose', 'loss', 'lost') THEN 1 ELSE 0 END AS games_lost
      FROM uno_games ug
    `,
  },
  {
    key: "rps",
    label: "RPS",
    selectSql: `
      SELECT
        'rps'::text AS game_key,
        'RPS'::text AS game_label,
        u.id AS user_id,
        COALESCE(rg.bet_amount::numeric, 0) AS amount_lost,
        COALESCE(rg.payout::numeric, 0) AS amount_won,
        CASE WHEN LOWER(COALESCE(rg.result, '')) = 'win' THEN 1 ELSE 0 END AS games_won,
        CASE WHEN LOWER(COALESCE(rg.result, '')) IN ('lose', 'loss', 'lost') THEN 1 ELSE 0 END AS games_lost
      FROM rps_games rg
      JOIN users u ON u.clerk_id = rg.user_id
      WHERE LOWER(COALESCE(rg.result, '')) NOT IN ('tie', 'draw')
    `,
  },
];

const gameStatsUnion = TRACKED_GAMES.map((game) => game.selectSql).join(
  " UNION ALL ",
);

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
      }),
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
      { status: 500 },
    );
  }
}
