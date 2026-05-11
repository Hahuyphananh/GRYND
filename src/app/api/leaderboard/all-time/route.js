import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchAllTimeLeaderboard,
  normalizeLeaderboardCategory,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const category = normalizeLeaderboardCategory(searchParams.get("category"));
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const { items, me } = await fetchAllTimeLeaderboard({
      category,
      limit,
      offset,
      clerkId: userId,
    });

    return Response.json({ items, me, category, limit, offset });
  } catch (error) {
    console.error("❌ Failed to load all-time leaderboard:", error);
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
