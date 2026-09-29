import { sql } from "../../../db/sql";
import { cacheOrFetch } from "../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../lib/redis/keys";

export async function POST(req) {
  try {
    const { page = 1, limit = 10 } = await req.json();
    const offset = (page - 1) * limit;
    const cacheKey = CacheKeys.recentGames(page, limit);

    const rows = await cacheOrFetch(
      cacheKey,
      CacheTTL.recentGames,
      async () => {
        const { rows: result } = await sql`
          (
            SELECT users.name AS username, 'Mines' AS gameType, mines_games.bet_amount AS betAmount, mines_games.payout AS payout, mines_games.created_at AS createdAt
            FROM mines_games
            INNER JOIN users ON users.id = mines_games.user_id
          )
          ORDER BY createdAt DESC
          LIMIT ${limit} OFFSET ${offset};
        `;
        return result;
      },
    );

    return new Response(JSON.stringify({ games: rows }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15" },
    });
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch recent games" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
