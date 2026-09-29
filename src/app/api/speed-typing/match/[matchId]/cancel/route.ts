// src/app/api/speed-typing/match/[matchId]/cancel/route.ts
//
// POST — close an open lobby. Only the creator, and only while the match is
// still `waiting`; once an opponent joins the only exit is a forfeit. A
// cancelled lobby never settled, so no rating, trophy or win counter moves.
//
// Same shape as every other game's cancel route: ALL state lives in
// `cancelMatch` (row lock, creator check, status check, canonical queue
// mirror) — this route only authenticates the caller, validates the id and
// broadcasts the invalidation. A missed broadcast costs a poll tick.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  cancelMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/speed-typing/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/speed-typing/realtime";

export const dynamic = "force-dynamic";

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
      errorType: "speed_typing_cancel_error",
      errorMessage:
        error instanceof Error ? error.message : "Speed Typing cancel failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/speed-typing/match/[matchId]/cancel",
      game: "Speed Typing",
      metadata: { operation: "cancel" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
