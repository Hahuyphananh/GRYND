import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchAllTimeLeaderboard,
  normalizeLeaderboardCategory,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const category = normalizeLeaderboardCategory(searchParams.get("category"));
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.leaderboard.allTime(category, limit, offset);

    const result = await cacheOrFetch(
      cacheKey,
      CacheTTL.leaderboard,
      () =>
        fetchAllTimeLeaderboard({
          category,
          limit,
          offset,
          clerkId: null, // Don't cache user-specific "me" data
        }),
    );

    // Compute "me" from cached items when user is in the results
    const items = result.items;
    let me = null;
    if (userId && Array.isArray(items)) {
      me = items.find((item) => item.clerk_id === userId) || null;
    }

    return Response.json({ items, me, category, limit, offset }, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
      },
    });
  } catch (error) {
    console.error(" Failed to load all-time leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        category,
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
