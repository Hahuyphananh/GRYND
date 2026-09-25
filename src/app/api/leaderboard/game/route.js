// app/api/leaderboard/game/route.js
//
// GET /api/leaderboard/game?game=chess&limit=50&offset=0
//
// THE game-specific leaderboard. Each rated game has its OWN board, ranked
// by that game's CURRENT Elo and nothing else:
//
//   Chess        → Chess Elo board
//   Pool Masters → Pool Masters Elo board
//   Precision    → Precision Elo board
//   Memory Grid  → Memory Grid Elo board
//   ...one board per key in RATED_GAMES.
//
// Ratings are NEVER combined, and there is deliberately no overall/cross-game
// Elo board — this route only ever reads the rows for the requested `game`.
//
// This replaced the old wins/payout-based per-game boards, which ranked
// wallets (solo games won when `payout > bet`) or simple win counts. The
// response shape is unchanged — `{ items, me, game, limit, offset }` plus a
// `label` and the full `games` list — so the leaderboard UI reuses its row
// rendering. Rows also carry `provisional` / `provisionalGamesCompleted` /
// `provisionalGamesRemaining` so a still-unplaced player is clearly labelled
// instead of being ranked as if their rating were settled.
//
// READ-ONLY. A rating can only be moved by server-side match settlement
// (src/lib/rating.js) — nothing in this route accepts a rating, a delta or an
// outcome, and there is no POST/PUT counterpart.

import { auth } from "@clerk/nextjs/server";
import {
  RATED_GAMES,
  fetchRatingLeaderboard,
  getRatingGameLabel,
  normalizeRatingGameKey,
} from "../../../../lib/rating";
import {
  clampLeaderboardLimit,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const game = normalizeRatingGameKey(searchParams.get("game"));
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.rating.board(game, limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.rating, () =>
      fetchRatingLeaderboard({ gameKey: game, limit, offset, clerkId: null }),
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
        const meResult = await fetchRatingLeaderboard({
          gameKey: game,
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my rating rank:", err);
      }
    }

    return Response.json(
      {
        items,
        me,
        game,
        label: getRatingGameLabel(game),
        // The full set of rated games, so the UI never hardcodes a list that
        // could drift from RATED_GAMES.
        games: RATED_GAMES.map((key) => ({ key, label: getRatingGameLabel(key) })),
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
    console.error(" Failed to load game rating leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        game,
        label: getRatingGameLabel(game),
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
