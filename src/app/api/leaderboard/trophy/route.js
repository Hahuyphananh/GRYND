// app/api/leaderboard/trophy/route.js
//
// GET /api/leaderboard/trophy?game=chess&limit=50&offset=0
//
// THE game-specific TROPHY leaderboard. Each rated game has its OWN board,
// ranked by that game's CURRENT trophy count and nothing else:
//
//   Chess        → Chess trophy board
//   Pool Masters → Pool Masters trophy board
//   ...
//
// Trophy counts are NEVER combined here (the cross-game board lives at
// /api/leaderboard/trophy-overall), and the game set is EXACTLY the Elo
// registry (TROPHY_GAMES ⇢ RATED_GAMES), so trophies and ratings can never
// disagree about which games are competitive.
//
// READ-ONLY. A trophy count can only be moved by server-side match settlement
// (src/lib/trophyStore.js) — nothing in this route accepts a trophy count, a
// delta or an outcome, and there is no POST/PUT counterpart.
//
// The response shape mirrors /api/leaderboard/game — `{ items, me, game,
// label, games, limit, offset }` — so the leaderboard UI reuses its row
// rendering. Rows also carry the per-game progression (`trophies`,
// `progressPercent`, `complete`, `phase`) and the Overall Trophies badge when
// the player qualifies for one.

import { auth } from "@clerk/nextjs/server";
import {
  fetchTrophyLeaderboard,
  listTrophyGames,
  normalizeTrophyGameKey,
} from "../../../../lib/trophyStore";
import { getTrophyGameLabel } from "../../../../lib/trophies";
import {
  clampLeaderboardLimit,
  normalizeLeaderboardOffset,
} from "../../../../lib/leaderboardQueries";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const game = normalizeTrophyGameKey(searchParams.get("game"));
  const limit = clampLeaderboardLimit(searchParams.get("limit"));
  const offset = normalizeLeaderboardOffset(searchParams.get("offset"));

  try {
    const { userId } = await auth();
    const cacheKey = CacheKeys.trophy.board(game, limit, offset);

    const result = await cacheOrFetch(cacheKey, CacheTTL.trophy, () =>
      fetchTrophyLeaderboard({ gameKey: game, limit, offset, clerkId: null }),
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
        const meResult = await fetchTrophyLeaderboard({
          gameKey: game,
          limit,
          offset,
          clerkId: userId,
        });
        me = meResult.me || null;
      } catch (err) {
        console.error(" Failed to load my trophy rank:", err);
      }
    }

    return Response.json(
      {
        items,
        me,
        game,
        label: getTrophyGameLabel(game),
        // The full set of trophy games, so the UI never hardcodes a list that
        // could drift from TROPHY_GAMES.
        games: listTrophyGames(),
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
    console.error(" Failed to load game trophy leaderboard:", error);
    return Response.json(
      {
        items: [],
        me: null,
        game,
        label: getTrophyGameLabel(game),
        limit,
        offset,
        error: "Unable to load leaderboard",
      },
      { status: 500 },
    );
  }
}
