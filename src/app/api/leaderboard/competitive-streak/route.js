// GET /api/leaderboard/competitive-streak?game=solitaire-duel&limit=50&offset=0
//
// One board per ranked format, ranked by that format's all-time best win streak
// in `user_competitive_streaks`. The two keys are never merged: an unknown or
// missing game value falls back to Solitaire Duel, and the query filters exactly
// one `game_key`.
//
// READ-ONLY. The table is written only by ranked settlement through
// `recordCompetitiveResult`; no request body can supply a streak or a result.

import { auth } from "@clerk/nextjs/server";
import {
  clampLeaderboardLimit,
  fetchCompetitiveStreakLeaderboard,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import {
  COMPETITIVE_STREAK_GAME_KEYS,
  COMPETITIVE_STREAK_LABELS,
  normalizeCompetitiveStreakGameKey,
} from "../../../../lib/competitiveStreakModel";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const game = normalizeCompetitiveStreakGameKey(searchParams.get("game"));
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.leaderboard.competitiveStreak(game, limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.leaderboard, () =>
      fetchCompetitiveStreakLeaderboard({
        gameKey: game,
        limit,
        offset,
        clerkId: null,
      }),
    );

    // The anonymous page is cached; "me" is resolved against the full ranked
    // set so a player outside this page still sees their true position.
    const items = Array.isArray(result.items) ? result.items : [];
    let me = userId
      ? items.find((item) => item.clerk_id === userId) || null
      : null;
    if (userId && !me) {
      try {
        const meResult = await fetchCompetitiveStreakLeaderboard({
          gameKey: game,
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my competitive streak rank:", err);
      }
    }

    return Response.json(
      {
        items,
        me,
        game,
        label: COMPETITIVE_STREAK_LABELS[game],
        // Both independent boards, so the UI never invents a merged list.
        games: COMPETITIVE_STREAK_GAME_KEYS.map((key) => ({
          key,
          label: COMPETITIVE_STREAK_LABELS[key],
        })),
        limit,
        offset,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=15",
        },
      },
    );
  } catch (error) {
    console.error(" Failed to load competitive streak leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        game,
        label: COMPETITIVE_STREAK_LABELS[game],
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
