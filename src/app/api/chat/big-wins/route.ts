import { NextResponse } from "next/server";
import { getNeonSql } from "../../../../db/neon";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

const MINIMUM_BIG_WIN_AMOUNT = 1000000; // 1 million tokens

export async function GET() {
  try {
    const wins = await cacheOrFetch(
      CacheKeys.bigWins(),
      CacheTTL.bigWins,
      async () => {
        const sql = getNeonSql();

        const result = await sql`
          SELECT 
            id,
            user_id as "userId",
            username,
            game,
            bet_amount as "betAmount",
            win_amount as "winAmount",
            multiplier,
            created_at as "createdAt"
          FROM big_wins
          WHERE win_amount >= ${MINIMUM_BIG_WIN_AMOUNT}
          ORDER BY created_at DESC
          LIMIT 50
        `;

        return result;
      },
    );

    return NextResponse.json({ wins }, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
      },
    });
  } catch (error) {
    console.error("Error fetching big wins:", error);
    return NextResponse.json(
      { error: "Failed to fetch big wins" },
      { status: 500 }
    );
  }
}