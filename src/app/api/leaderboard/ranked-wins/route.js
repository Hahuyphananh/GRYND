// app/api/leaderboard/ranked-wins/route.js
//
// GET /api/leaderboard/ranked-wins?limit=50&offset=0
//
// The ALL-TIME WINS board. It ranks RANKED wins only — the per-game `wins`
// column on `player_ratings`, summed across games — so a match that never
// moved a rating cannot climb this board. `user_stats.wins` is deliberately
// not read here: it counts every settled result, rated or not.
//
// READ-ONLY. No request body is read and there is no POST counterpart.

import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchRankedWinsLeaderboard,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

const LABEL = "All-Time Wins";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.leaderboard.rankedWins(limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.leaderboard, () =>
      fetchRankedWinsLeaderboard({ limit, offset, clerkId: null }),
    );

    const items = Array.isArray(result.items) ? result.items : [];
    let me = userId
      ? items.find((item) => item.clerk_id === userId) || null
      : null;

    // Signed-in player outside the paged window: resolve their TRUE rank with
    // an uncached per-user read, so the cached page stays user-agnostic.
    if (userId && !me) {
      try {
        const meResult = await fetchRankedWinsLeaderboard({
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my ranked-wins rank:", err);
      }
    }

    return Response.json(
      { items, me, label: LABEL, limit, offset },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
        },
      },
    );
  } catch (error) {
    console.error(" Failed to load ranked-wins leaderboard:", error);
    return Response.json(
      { items: [], me: null, label: LABEL, limit, offset, error: "Unable to load leaderboard" },
      { status: 500 },
    );
  }
}
