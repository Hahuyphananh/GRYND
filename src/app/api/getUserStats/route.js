import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function POST() {
  try {
    const { rows } = await sql`
      SELECT
        users.id AS user_id,
        users.name AS username,
        users.email AS email, -- or user image field if you have it
        users.games_won AS gamesWon,
        users.games_lost AS gamesLost,
        COALESCE(SUM(
          COALESCE(roulette_games.payout, 0) +
          COALESCE(crash_games.payout, 0) +
          COALESCE(poker_games.payout, 0) +
          COALESCE(blackjack_games.payout, 0) +
          COALESCE(mines_games.payout, 0) +
          COALESCE(plinko_games.payout, 0)
        ), 0) AS total_won,
        (
          COALESCE((SELECT COUNT(*) FROM roulette_games WHERE user_id = users.id), 0) +
          COALESCE((SELECT COUNT(*) FROM crash_games WHERE user_id = users.id), 0) +
          COALESCE((SELECT COUNT(*) FROM poker_games WHERE user_id = users.id), 0) +
          COALESCE((SELECT COUNT(*) FROM blackjack_games WHERE user_id = users.id), 0) +
          COALESCE((SELECT COUNT(*) FROM mines_games WHERE user_id = users.id), 0) +
          COALESCE((SELECT COUNT(*) FROM plinko_games WHERE user_id = users.id), 0)
        ) AS total_bets
      FROM users
      LEFT JOIN roulette_games ON roulette_games.user_id = users.id
      LEFT JOIN crash_games ON crash_games.user_id = users.id
      LEFT JOIN poker_games ON poker_games.user_id = users.id
      LEFT JOIN blackjack_games ON blackjack_games.user_id = users.id
      LEFT JOIN mines_games ON mines_games.user_id = users.id
      LEFT JOIN plinko_games ON plinko_games.user_id = users.id
      GROUP BY users.id
      ORDER BY total_won DESC
      LIMIT 50;
    `;

    return new Response(
      JSON.stringify({ stats: rows }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ error: "Error fetching leaderboard stats" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
