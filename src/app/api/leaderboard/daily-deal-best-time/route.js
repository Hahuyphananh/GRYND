// app/api/leaderboard/daily-deal-best-time/route.js
//
// GET /api/leaderboard/daily-deal-best-time?limit=50&offset=0
//
// The DAILY DEAL BEST TIME board: each player's fastest COMPLETED daily deal,
// ranked fastest first. The times come from the official result rows
// (`solitaire_daily_results`), so an unfinished or unverified run has no entry
// and `elapsed_ms = 0` never ranks. The row also carries `runs`, the number of
// completed deals the best time was taken from.
//
// READ-ONLY. No request body is read and there is no POST counterpart.

import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchDailyDealBestTimeLeaderboard,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

const LABEL = "Daily Deal Best Time";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.leaderboard.dailyDealBestTime(limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.leaderboard, () =>
      fetchDailyDealBestTimeLeaderboard({ limit, offset, clerkId: null }),
    );

    const items = Array.isArray(result.items) ? result.items : [];
    let me = userId
      ? items.find((item) => item.clerk_id === userId) || null
      : null;

    if (userId && !me) {
      try {
        const meResult = await fetchDailyDealBestTimeLeaderboard({
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my daily-deal rank:", err);
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
    console.error(" Failed to load daily-deal best-time leaderboard:", error);
    return Response.json(
      { items: [], me: null, label: LABEL, limit, offset, error: "Unable to load leaderboard" },
      { status: 500 },
    );
  }
}
