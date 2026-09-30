// src/app/api/solitaire-duel/match/[matchId]/cancel/route.ts
//
// POST — close an open lobby. Only the creator, and only while the match is
// still `waiting`; once an opponent joins, the only exit from a live race is a
// forfeit (or the platform's disconnect path).
//
// A cancelled lobby never settled, so no rating, trophy, win counter or move
// log entry moves — the store's `cancelMatch` deliberately does not call the
// settlement seam. Note also that a cancelled row keeps the seed/deal it minted
// at creation; a rematch is a NEW row with a NEW seed, never a resumed one.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  cancelMatch,
  isMatchId,
  matchToDto,
} from "../../../../../../lib/solitaire-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/solitaire-duel/rooms";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
  }

  try {
    const result = await cancelMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    broadcastMatchUpdate(matchId, { status: result.match.status, cancelled: true });

    return NextResponse.json({
      success: true,
      data: { match: matchToDto(result.match, userId) },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_cancel_error",
      errorMessage: error instanceof Error ? error.message : "Solitaire Duel cancel failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]/cancel",
      game: "Solitaire Duel",
      metadata: { operation: "cancel" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
