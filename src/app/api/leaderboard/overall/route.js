// app/api/leaderboard/overall/route.js
//
// GET /api/leaderboard/overall?limit=50&offset=0
//
// THE cross-game OVERALL ELO board. It ranks players by the arithmetic mean
// of their ESTABLISHED game-specific Elo ratings and only lists players who
// have an established rating in at least OVERALL_MIN_GAMES different games
// (see src/lib/elo.js).
//
// Overall Elo is an AGGREGATE only: it has no rating of its own, no K-factor,
// no match results and no writer. It is computed from the same
// `player_ratings` rows the per-game boards read, so a game rating change is
// reflected on the next read. The board carries no token/winnings column.
//
// READ-ONLY. There is no POST/PUT counterpart and no request body is read, so
// a client can never submit an overallElo value.
//
// The response shape mirrors /api/leaderboard/game — `{ items, me, label,
// minGames, limit, offset }` — so the leaderboard UI reuses its row rendering.

import { auth } from "@clerk/nextjs/server";
import {
  OVERALL_ELO_LABEL,
  fetchOverallEloLeaderboard,
} from "../../../../lib/rating";
import { OVERALL_MIN_GAMES } from "../../../../lib/elo";
import {
  clampLeaderboardLimit,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { consumeRateLimit } from "../../../../lib/security/rateLimit";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

/**
 * Hard ceiling on `offset`. `limit` is already clamped to 1–100 by the shared
 * helper; an unbounded offset is a cheap but pointless deep paging request, so
 * it is capped here rather than letting arbitrary values through.
 */
const MAX_OVERALL_OFFSET = 10_000;

function clientIp(request) {
  const raw =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return String(raw).split(",")[0].trim() || "unknown";
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = Math.min(normalizeLeaderboardOffset(searchParams.get("offset")), MAX_OVERALL_OFFSET);

  // Rate limit: 60 requests/minute per IP (in-memory fallback when the
  // remote KV limiter is unavailable — see consumeRateLimit). The board is
  // cache-backed, but the limiter still stops a client hammering it.
  const rateLimitResult = await consumeRateLimit(`leaderboard-overall:${clientIp(request)}`, {
    windowMs: 60_000,
    max: 60,
  });
  if (!rateLimitResult.allowed) {
    return Response.json(
      {
        items: [],
        me: null,
        game: "overall",
        label: OVERALL_ELO_LABEL,
        minGames: OVERALL_MIN_GAMES,
        limit,
        offset,
        error: "Too many requests, please try again later",
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(rateLimitResult.limit),
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(rateLimitResult.resetAt),
          "Retry-After": String(
            Math.max(1, Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)),
          ),
        },
      },
    );
  }

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.rating.overall(limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.rating, () =>
      fetchOverallEloLeaderboard({ limit, offset, clerkId: null }),
    );

    const items = Array.isArray(result.items) ? result.items : [];

    // The public (anonymous) board is what gets cached; "me" is always
    // resolved against the full ranked set so a player outside the current
    // page still sees their TRUE position.
    let me = userId
      ? items.find((item) => item.clerk_id === userId) || null
      : null;
    if (userId && !me) {
      try {
        const meResult = await fetchOverallEloLeaderboard({
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my overall Elo rank:", err);
      }
    }

    return Response.json(
      {
        items,
        me,
        game: "overall",
        label: OVERALL_ELO_LABEL,
        // The eligibility rule travels with the board so the UI can explain
        // itself (and can never drift from the server's constant).
        minGames: OVERALL_MIN_GAMES,
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
    console.error(" Failed to load overall Elo leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        game: "overall",
        label: OVERALL_ELO_LABEL,
        minGames: OVERALL_MIN_GAMES,
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
