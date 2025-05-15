import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function POST(req) {
  try {
    const { page = 1, limit = 10 } = await req.json();
    const offset = (page - 1) * limit;

    const { rows } = await sql`
      (
        SELECT users.name AS username, 'Roulette' AS gameType, roulette_games.bet_amount AS betAmount, roulette_games.payout AS payout, roulette_games.created_at AS createdAt
        FROM roulette_games
        INNER JOIN users ON users.id = roulette_games.user_id
      )
      UNION ALL
      (
        SELECT users.name, 'Crash', crash_games.bet_amount, crash_games.payout, crash_games.created_at
        FROM crash_games
        INNER JOIN users ON users.id = crash_games.user_id
      )
      UNION ALL
      (
        SELECT users.name, 'Poker', poker_games.bet_amount, poker_games.payout, poker_games.created_at
        FROM poker_games
        INNER JOIN users ON users.id = poker_games.user_id
      )
      UNION ALL
      (
        SELECT users.name, 'Blackjack', blackjack_games.bet_amount, blackjack_games.payout, blackjack_games.created_at
        FROM blackjack_games
        INNER JOIN users ON users.id = blackjack_games.user_id
      )
      UNION ALL
      (
        SELECT users.name, 'Mines', mines_games.bet_amount, mines_games.payout, mines_games.created_at
        FROM mines_games
        INNER JOIN users ON users.id = mines_games.user_id
      )
      UNION ALL
      (
        SELECT users.name, 'Plinko', plinko_games.bet_amount, plinko_games.payout, plinko_games.created_at
        FROM plinko_games
        INNER JOIN users ON users.id = plinko_games.user_id
      )
      ORDER BY createdAt DESC
      LIMIT ${limit} OFFSET ${offset};
    `;

    return new Response(
      JSON.stringify({ games: rows }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch recent games" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
