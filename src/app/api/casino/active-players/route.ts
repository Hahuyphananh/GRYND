// app/api/casino/active-players/route.ts
//
// GET /api/casino/active-players
//   → { success: true, counts: { roulette: 12, crash: 8, rps: 5 }, generatedAt }
//
// The only reader of the presence table: AGGREGATE COUNTS ONLY, keyed by the
// canonical game id (the lobby's `leaderboardKey`, so /casino renders it with a
// plain `counts[game.leaderboardKey]`). It never returns user ids, emails,
// usernames, session ids, per-game player lists, or anything else that could
// identify a player — that is a hard rule, not a limitation of the query.
//
// Shape notes:
//   * Games with nobody playing are ABSENT (never sent as 0), so the lobby can
//     hide the badge with no extra logic.
//   * A presence row counts only while last_seen_at is inside the activity
//     window (src/lib/gamePresence.js → ACTIVE_PLAYER_WINDOW_SECONDS = 3 min),
//     so stale sessions stop counting without needing an explicit leave.
//   * Unauthenticated on purpose, like GET /api/game-plays and
//     GET /api/stats/live: this is public lobby chrome about no one in
//     particular, so signed-out visitors may see it too.
//
// Performance: one cached GROUP BY. The predicate is index-backed by
// (game_key, last_seen_at) and the table holds at most `users × games` rows, so
// a lobby poll is a Redis GET rather than a Postgres scan. `countActivePlayers`
// computes the cutoff in JS and passes it as a parameter instead of using
// NOW() - INTERVAL, so the expiration rule is a tested pure function.

import { NextResponse } from "next/server";
import { cacheOrFetch } from "../../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../../lib/redis/keys";
import { countActivePlayers } from "../../../../lib/gamePresenceStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await cacheOrFetch(CacheKeys.activePlayers(), CacheTTL.activePlayers, () =>
      countActivePlayers()
    );

    return NextResponse.json(
      {
        success: true,
        counts: counts ?? {},
        generatedAt: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          // Lobby chrome: shareable between tabs/edge for a few seconds, with a
          // short stale window so a refresh never blocks on Postgres.
          "Cache-Control": "public, s-maxage=10, stale-while-revalidate=5",
        },
      }
    );
  } catch (error) {
    console.error("[ACTIVE_PLAYERS_ERROR]", error);
    // Fail closed: no counts is a cosmetic downgrade, never a broken lobby.
    return NextResponse.json(
      { success: false, counts: {}, generatedAt: new Date().toISOString() },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}
