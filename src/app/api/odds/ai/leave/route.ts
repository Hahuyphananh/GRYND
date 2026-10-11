// POST /api/odds/ai/leave
//
// The "I am done with this AI duel" endpoint. The vs-AI game in
// src/app/casino/odds/PageClient.tsx calls it the moment the player leaves
// the page — an in-app navigation, a logout, a refresh or a closed tab
// (best effort, via `sendBeacon`) — so a duel the player walked away from
// stops instead of coming back as a stale board.
//
// Body (all optional): { gameId?: number }
//   * gameId given → that one duel is abandoned (only when it belongs to
//     the caller, is an AI game and is still playing)
//   * no gameId    → every still-playing AI duel for the caller is abandoned
//
// Abandoning flips the row to `cancelled` and stamps `endedAt`: the game
// stops counting as active, so /api/odds/ai/status no longer finds it and
// the lobby shows again. `cancelled` also keeps the abandoned duel out of
// bet history, which only lists `finished`/`forfeit` rows. AI duels are
// free play, so there is no stake to settle and no stats / leaderboard
// write. Identity comes from the Clerk session, never the body, so a caller
// can only ever leave their OWN game. Idempotent — an already gone or
// already finished game returns success, so retries and double-fires
// (button + unload beacon) are safe.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requirePracticePlayer } from "../../../../../lib/auth/guestSession";
import { db } from "../../../../../db/client";
import { oddsGames } from "../../../../../db/schema";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;

    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "Database not available" },
        { status: 503 },
      );
    }

    // An unload beacon may send an empty body, so a parse failure means
    // "leave everything" rather than a 400.
    const body = await req.json().catch(() => ({}));
    const requestedId = Number(body?.gameId);
    const hasGameId = Number.isFinite(requestedId) && requestedId > 0;

    // Only ever touch the caller's own still-playing AI duels.
    const scope = hasGameId
      ? and(
          eq(oddsGames.id, requestedId),
          eq(oddsGames.player1Id, userId),
          eq(oddsGames.isAi, true),
          eq(oddsGames.status, "playing"),
        )
      : and(
          eq(oddsGames.player1Id, userId),
          eq(oddsGames.isAi, true),
          eq(oddsGames.status, "playing"),
        );

    const abandoned = await db
      .update(oddsGames)
      .set({ status: "cancelled", endedAt: new Date() })
      .where(scope)
      .returning({ id: oddsGames.id });

    return NextResponse.json({
      success: true,
      data: { abandoned: abandoned.length },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to leave game" },
      { status: 500 },
    );
  }
}
