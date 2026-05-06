import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchWeeklyLeaderboard,
  normalizeLeaderboardCategory,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";

export async function GET(request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  const category = normalizeLeaderboardCategory(searchParams.get("category"));
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  const { items, me } = await fetchWeeklyLeaderboard({ category, limit, offset, clerkId: userId });

  return Response.json({ items, me, category, limit, offset });
}
