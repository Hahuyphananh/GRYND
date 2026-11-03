// src/app/api/battleship/create-or-join/route.ts
//
// POST — match the caller into the oldest open Battleship lobby, or open one.
//
// Ranked matchmaking, existing infrastructure: a real, age-verified Clerk player
// (the same gate every other ranked duel uses), the game's own `createOrJoin`
// primitive under one per-game advisory lock. Battleship is FREE TO PLAY, so
// there is no stake in the body, no `requireStake` call, no escrow and no payout.
//
// The route reads NO game state from the request: no phase, no seat, no player
// id and no winner. The only identity it uses is `gate.userId`.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../lib/logError";
import { createOrJoin, matchDto } from "../../../../lib/battleship/serverStore";
import { seatForUser } from "../../../../lib/battleship/seats";
import { broadcastMatchUpdate } from "../../../../lib/battleship/rooms";

export async function POST() {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  try {
    const result = await createOrJoin({ userId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Best-effort push so a host already on the match screen flips to placement
    // without waiting for the next poll. A missed push never fails the route.
    broadcastMatchUpdate(result.match.id, {
      phase: result.match.phase,
      joined: result.joined,
    });

    const seat = seatForUser(result.match, userId) ?? "player1";
    return NextResponse.json({
      success: true,
      data: {
        matchId: result.match.id,
        joined: result.joined,
        match: matchDto(result.match, seat),
      },
    });
  } catch (error) {
    await logError({
      errorType: "battleship_create_or_join_error",
      errorMessage: error instanceof Error ? error.message : "Battleship matchmaking failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/create-or-join",
      game: "Battleship",
      metadata: { operation: "create_or_join" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
