// src/app/api/solitaire-duel/match/[matchId]/forfeit/route.ts
//
// POST — resign a live match.
//
// The opponent is awarded the win and the row settles through exactly the same
// seam as a played-out completion (the shared rating/trophy writers, exactly
// once). The store decides that from the seat the caller holds: the request
// carries no winner, no result and no score, and a resignation is a loss
// regardless of who was ahead on the board.
//
// Note this is NOT the disconnect path. A dropped socket is handled by
// /api/solitaire-duel/disconnect-forfeit, which the realtime server calls after
// its grace window — so a refresh never costs a rated race.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import {
  forfeitMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/solitaire-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/solitaire-duel/rooms";
import { broadcastMatchFinished } from "../../../../../../lib/solitaire-duel/realtime";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
  }

  try {
    const result = await forfeitMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: true,
      result: result.match.result ?? null,
    });
    broadcastMatchFinished({
      matchId,
      status: result.match.status,
      result: result.match.result,
      winnerId: result.match.winnerId,
      resolutionReason: result.match.resolutionReason,
      endedAtMs: result.match.endedAt ? new Date(result.match.endedAt).getTime() : null,
    });

    return NextResponse.json({
      success: true,
      data: { match: matchToDto(result.match, userId) },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_forfeit_error",
      errorMessage: error instanceof Error ? error.message : "Solitaire Duel forfeit failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]/forfeit",
      game: "Solitaire Duel",
      metadata: { operation: "forfeit" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
