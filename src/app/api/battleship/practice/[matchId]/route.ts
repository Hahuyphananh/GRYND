// src/app/api/battleship/practice/[matchId]/route.ts
//
// GET — the authoritative snapshot of a PRACTICE match.
//
// Same store call as the ranked snapshot, behind the practice gate instead of the
// age gate, so a signed-out guest that created the match can read it. The store
// still authorises by seat (403 for anyone else) and still projects only the
// viewer's own fleet, so joining a practice match id cannot reveal the bot's
// ships or drive its rounds.
//
// The response additionally carries `isAi` / `aiDifficulty`, which is what the
// screen uses to label the opponent and show the tier.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../../lib/auth/guestSession";
import { logError } from "../../../../../lib/logError";
import { fetchMatch, isMatchId } from "../../../../../lib/battleship/serverStore";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  publishForfeit,
  publishRoundResult,
  publishTimeoutNotice,
} from "../../../../../lib/battleship/publish";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthenticated" },
      { status: 401 },
    );
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await fetchMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // A PRACTICE route may only ever drive a practice match. A guest cannot hold
    // a seat in a ranked row anyway, but refusing explicitly keeps the two
    // surfaces from ever being interchangeable.
    if (result.dto.isAi !== true) {
      return NextResponse.json(
        { success: false, error: "This is not a practice match" },
        { status: 403 },
      );
    }

    let players = null;
    try {
      players = await getSeatIdentity(
        result.dto.seats.player1Id,
        result.dto.seats.player2Id ?? null,
      );
    } catch {
      players = null;
    }

    for (const event of result.events ?? []) {
      if (event.kind === "round_resolved") publishRoundResult(event.matchId, event.round);
      else if (event.kind === "attack_timeout") {
        publishTimeoutNotice(event.matchId, event.round, event.seats);
      } else publishForfeit(event);
    }

    return NextResponse.json({ success: true, data: { ...result.dto, players } });
  } catch (error) {
    await logError({
      errorType: "battleship_practice_fetch_error",
      errorMessage: error instanceof Error ? error.message : "Battleship practice fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/practice/[matchId]",
      game: "Battleship",
      metadata: { operation: "practice_snapshot" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
