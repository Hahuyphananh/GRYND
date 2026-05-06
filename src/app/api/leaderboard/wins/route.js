import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchWinsLeaderboard,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";

export async function GET(request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const { items, me } = await fetchWinsLeaderboard({ limit, offset, clerkId: userId });

    return Response.json({ items, me, limit, offset });
  } catch (error) {
    console.error("❌ Failed to load wins leaderboard:", error);
    return Response.json({ items: [], me: null, limit, offset, error: "Unable to load leaderboard" }, { status: 500 });
  }
}
