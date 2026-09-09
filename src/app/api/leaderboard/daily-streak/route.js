// app/api/leaderboard/daily-streak/route.js
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  clampLeaderboardLimit,
  normalizeLeaderboardOffset,
  fetchDailyStreakLeaderboard,
  fetchWeeklyStreakLeaderboard,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

/**
 * GET /api/leaderboard/daily-streak?type=current&limit=50
 * GET /api/leaderboard/daily-streak?type=best&limit=50
 * GET /api/leaderboard/daily-streak?type=weekly-current&limit=50
 * GET /api/leaderboard/daily-streak?type=weekly-best&limit=50
 *
 * - current: Ranks by current active daily streak (resets on missed day)
 * - best: Ranks by all-time best daily streak (never decreases)
 * - weekly-current: Ranks by current week's daily streak (resets every Monday)
 * - weekly-best: Ranks by all-time best weekly streak (never decreases)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const rawType = searchParams.get("type") || "current";
    const limit = clampLeaderboardLimit(searchParams.get("limit"));
    const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

    const { userId } = await auth();
    const cacheKey = CacheKeys.leaderboard.dailyStreak(rawType, limit, offset);

    const result = await cacheOrFetch(
      cacheKey,
      CacheTTL.leaderboard,
      () => {
        if (rawType === "weekly-current" || rawType === "weekly-best") {
          return fetchWeeklyStreakLeaderboard({
            type: rawType,
            limit,
            offset,
            clerkId: null, // Don't cache user-specific "me" data
          });
        }
        const type = rawType === "best" ? "best" : "current";
        return fetchDailyStreakLeaderboard({
          type,
          limit,
          offset,
          clerkId: null, // Don't cache user-specific "me" data
        });
      },
    );

    // Compute "me" from cached items when user is in the results
    const items = result.items;
    let me = null;
    if (userId && Array.isArray(items)) {
      me = items.find((item) => item.clerk_id === userId) || null;
    }

    // Signed-in user outside the paged window: resolve their TRUE rank with
    // an uncached per-user query (the query layer computes `me` against the
    // full ranked set, not the paged slice). Keeps cached responses public.
    if (userId && !me) {
      try {
        if (rawType === "weekly-current" || rawType === "weekly-best") {
          const meResult = await fetchWeeklyStreakLeaderboard({
            type: rawType,
            limit,
            offset,
            clerkId: userId,
          });
          me = meResult.me || null;
        } else {
          const type = rawType === "best" ? "best" : "current";
          const meResult = await fetchDailyStreakLeaderboard({
            type,
            limit,
            offset,
            clerkId: userId,
          });
          me = meResult.me || null;
        }
      } catch (err) {
        console.error(" Failed to load my leaderboard rank:", err);
      }
    }

    return NextResponse.json({ items, me, type: rawType, limit, offset }, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
      },
    });
  } catch (error) {
    console.error(" Failed to load daily streak leaderboard:", error);
    return NextResponse.json(
      {
        items: [],
        me: null,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
