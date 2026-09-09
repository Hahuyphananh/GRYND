import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchWinsLeaderboard,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.leaderboard.wins(limit, offset);

    const result = await cacheOrFetch(
      cacheKey,
      CacheTTL.leaderboard,
      () =>
        fetchWinsLeaderboard({
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

    // Signed-in user outside the paged window: resolve their TRUE rank with
    // an uncached per-user query (the query layer computes `me` against the
    // full ranked set, not the paged slice). Keeps cached responses public.
    if (userId && !me) {
      try {
        const meResult = await fetchWinsLeaderboard({
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my leaderboard rank:", err);
      }
    }

    return Response.json({ items, me, limit, offset }, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
      },
    });
  } catch (error) {
    console.error(" Failed to load wins leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
