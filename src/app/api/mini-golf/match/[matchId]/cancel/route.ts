// src/app/api/mini-golf/match/[matchId]/cancel/route.ts
//
// POST — close an open lobby. Only the creator, and only while the match is
// still `waiting`; once an opponent joins the only exit is a forfeit. A
// cancelled lobby never settled, so no rating, trophy or win counter moves.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  cancelMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/mini-golf/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/mini-golf/rooms";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
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
    const result = await cancelMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      cancelled: true,
    });

    return NextResponse.json({
      success: true,
      data: { match: matchToDto(result.match, userId) },
    });
  } catch (error) {
    await logError({
      errorType: "mini_golf_cancel_error",
      errorMessage:
        error instanceof Error ? error.message : "Mini Golf cancel failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/mini-golf/match/[matchId]/cancel",
      game: "Mini Golf",
      metadata: { operation: "cancel" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
