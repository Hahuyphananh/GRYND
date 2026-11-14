// src/app/api/solitaire-duel/match/[matchId]/undo/route.ts
//
// POST — take back this seat's last move, in a PRACTICE match only.
//
// The request body carries NOTHING: no move, no board, no ply. The store replays
// the seat's own stored log minus its final entry and rewrites the seat's board
// from the engine, inside one row-locked transaction, so the rollback can only
// ever reach a position the server itself produced.
//
// A ranked duel answers 409 `Undo is only available in a practice match`: a
// rated race has an opponent running the same deal, and the stored log is the
// record of what actually happened. The client never offers the control there.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  seatsFromRow,
  stateForSeat,
  undoMove,
} from "../../../../../../lib/solitaire-duel/serverStore";
import { seatForUser } from "../../../../../../lib/solitaire-duel/rules";
import { broadcastMatchUpdate } from "../../../../../../lib/solitaire-duel/rooms";
import { broadcastOpponentProgress } from "../../../../../../lib/solitaire-duel/realtime";

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
    const result = await undoMove({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    const seat = seatForUser(seatsFromRow(result.match), userId);
    const nowMs = Date.now();

    // The opponent's (bot's) view of the race is unchanged by a rollback, but a
    // projection keeps the realtime feed's numbers in step with the row.
    if (seat) {
      broadcastOpponentProgress({
        matchId,
        seat,
        state: stateForSeat(result.match, seat),
        nowMs,
      });
    }
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      ply: result.ply,
      completed: false,
      result: result.match.result ?? null,
    });

    return NextResponse.json({
      success: true,
      data: {
        // The authoritative post-rollback board for the acting seat.
        match: matchToDto(result.match, userId, nowMs),
        ply: result.ply,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_undo_error",
      errorMessage: error instanceof Error ? error.message : "Solitaire Duel undo failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]/undo",
      game: "Solitaire Duel",
      metadata: { operation: "undo" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
