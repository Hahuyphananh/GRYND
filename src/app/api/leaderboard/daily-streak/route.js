// app/api/leaderboard/daily-streak/route.js
import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  clampLeaderboardLimit,
  normalizeLeaderboardOffset,
  fetchDailyStreakLeaderboard,
  fetchWeeklyStreakLeaderboard,
} from "../../../../lib/leaderboardQueries";

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

    let items, me;

    if (rawType === "weekly-current" || rawType === "weekly-best") {
      ({ items, me } = await fetchWeeklyStreakLeaderboard({
        type: rawType,
        limit,
        offset,
        clerkId: userId,
      }));
    } else {
      const type = rawType === "best" ? "best" : "current";
      ({ items, me } = await fetchDailyStreakLeaderboard({
        type,
        limit,
        offset,
        clerkId: userId,
      }));
    }

    return NextResponse.json({ items, me, type: rawType, limit, offset });
  } catch (error) {
    console.error("❌ Failed to load daily streak leaderboard:", error);
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
