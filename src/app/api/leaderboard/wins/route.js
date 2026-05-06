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

  const { items, me } = await fetchWinsLeaderboard({ limit, offset, clerkId: userId });

  return Response.json({ items, me, limit, offset });
}
