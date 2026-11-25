// app/api/leaderboard/trophy-peak/route.js
//
// GET /api/leaderboard/trophy-peak?limit=50&offset=0
//
// The ALL-TIME PEAK TROPHIES board. It ranks players by the SUM of each game's
// `peak_trophies` — the highest count they have ever held in that game — and,
// like the current Overall Trophies board, only lists players with a trophy row
// in at least OVERALL_TROPHY_MIN_GAMES games.
//
// Peak is monotonic on every `player_trophies` row (`GREATEST(peak, after)` in
// the settlement writer), so a losing run can never erase a player's best-ever
// total. The current total travels on every row as `overallTrophies`.
//
// READ-ONLY. No request body is read and there is no POST counterpart.

import { auth } from "@clerk/nextjs/server";
import { fetchOverallTrophyLeaderboard } from "../../../../lib/trophyStore";
import {
  OVERALL_TROPHY_MIN_GAMES,
} from "../../../../lib/trophies";
import {
  clampLeaderboardLimit,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

const LABEL = "All-Time Peak Trophies";
const MAX_OFFSET = 10_000;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = Math.min(
    normalizeLeaderboardOffset(searchParams.get("offset")),
    MAX_OFFSET,
  );

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.trophy.peak(limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.trophy, () =>
      fetchOverallTrophyLeaderboard({ limit, offset, clerkId: null, metric: "peak" }),
    );

    const items = Array.isArray(result.items) ? result.items : [];

    let me = userId
      ? items.find((item) => item.clerk_id === userId) || null
      : null;
    if (userId && !me) {
      try {
        const meResult = await fetchOverallTrophyLeaderboard({
          limit,
          offset,
          clerkId: userId,
          metric: "peak",
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my peak trophy rank:", err);
      }
    }

    return Response.json(
      {
        items,
        me,
        game: "overall",
        label: LABEL,
        minGames: OVERALL_TROPHY_MIN_GAMES,
        limit,
        offset,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
        },
      },
    );
  } catch (error) {
    console.error(" Failed to load peak trophy leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        game: "overall",
        label: LABEL,
        minGames: OVERALL_TROPHY_MIN_GAMES,
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
