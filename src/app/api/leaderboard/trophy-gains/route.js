// app/api/leaderboard/trophy-gains/route.js
//
// GET /api/leaderboard/trophy-gains?period=week|month|year&limit=50&offset=0
//
// The TROPHY-GAIN board for the current UTC calendar period. It sums only the
// POSITIVE deltas from `trophy_events` inside the window, so it ranks who
// climbed the most this week / month / year — not who has the best net.
//
// The journal is written exclusively by server-side settlement, inside the
// same transaction as the trophy update, so this board cannot be influenced by
// a client payload. Read-only: no body, no POST counterpart.

import { auth } from "@clerk/nextjs/server";
import {
  TROPHY_GAIN_PERIODS,
  fetchTrophyGainLeaderboard,
  isTrophyGainPeriod,
} from "../../../../lib/trophyStore";
import {
  clampLeaderboardLimit,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

const LABELS = {
  week: "Trophies Gained This Week",
  month: "Trophies Gained This Month",
  year: "Trophies Gained This Year",
};

const MAX_OFFSET = 10_000;

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const requested = searchParams.get("period");
  const period = isTrophyGainPeriod(requested) ? requested : "week";
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = Math.min(
    normalizeLeaderboardOffset(searchParams.get("offset")),
    MAX_OFFSET,
  );
  const label = LABELS[period];

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.trophy.gains(period, limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.trophy, () =>
      fetchTrophyGainLeaderboard({ period, limit, offset, clerkId: null }),
    );

    const items = Array.isArray(result.items) ? result.items : [];

    let me = userId
      ? items.find((item) => item.clerk_id === userId) || null
      : null;
    if (userId && !me) {
      try {
        const meResult = await fetchTrophyGainLeaderboard({
          period,
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my trophy-gain rank:", err);
      }
    }

    return Response.json(
      {
        items,
        me,
        game: "overall",
        label,
        period,
        periods: [...TROPHY_GAIN_PERIODS],
        since: result.since ?? null,
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
    console.error(" Failed to load trophy-gain leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        game: "overall",
        label,
        period,
        periods: [...TROPHY_GAIN_PERIODS],
        since: null,
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
