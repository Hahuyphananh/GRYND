// src/app/api/dominoes/match/[matchId]/route.ts
//
// GET — the authoritative match snapshot for the calling participant.
//
// THE VIEWER PROJECTION IS THE ONLY SHAPE THAT LEAVES THIS ROUTE. `fetchMatch`
// builds it from the row: the VIEWER's own hand, the OPPONENT's tile count, the
// public chain and open ends, the draw-pile COUNT, the turn, the deadline and
// the public result. The opponent's tiles and the pile's order are not part of
// the DTO at all (they live in their own columns — see src/db/schema.ts), so
// there is nothing to redact and nothing a future field could accidentally
// publish.
//
// A non-participant gets a 403: online Dominoes has no spectator mode, which is
// also what keeps the hidden hands hidden.
//
// THIS READ CAN ADVANCE THE CLOCK. An elapsed turn is resolved inside the
// store's row-locked read (`applyTimeout`: draw one tile if the pile allows,
// otherwise pass), which is the platform's documented pattern for clocked
// games (src/lib/deadlineRead.ts) — there is no polling loop and no cron. When
// it happens, the opponent is notified with a bare invalidation poke; the
// payload carries no position, only the fact that the row moved.
//
// It is also the RECONNECT path: a refreshed tab or a new device re-reads the
// same row, and the deal is restored from the columns rather than re-minted, so
// the hand and the pile are exactly what they were.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  fetchMatch,
  fetchMatchMoves,
  isMatchId,
} from "../../../../../lib/dominoes/serverStore";
import { broadcastMatchUpdate } from "../../../../../lib/dominoes/rooms";

export async function GET(
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
    const result = await fetchMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    const match = result.match;

    // Move history + seat identity are adornments: a failure here must not fail
    // the snapshot (the board renders from the projection alone).
    let moves: unknown[] = [];
    try {
      moves = await fetchMatchMoves(matchId);
    } catch {
      moves = [];
    }

    let players = null;
    try {
      players = await getSeatIdentity(match.player1Id, match.player2Id ?? null);
    } catch {
      players = null;
    }

    // A read that resolved the turn clock is news to the OTHER seat too. The
    // payload is a hint (status + version + who is on turn), never a position.
    if (result.timedOut) {
      broadcastMatchUpdate(matchId, {
        status: match.status,
        version: match.ply,
        currentTurnUserId: match.currentTurnUserId ?? null,
        timedOut: true,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        ...result.dto,
        players,
        moves,
        /** True when this read resolved an expired turn. */
        timedOut: result.timedOut === true,
      },
    });
  } catch (error) {
    await logError({
      errorType: "dominoes_match_fetch_error",
      errorMessage:
        error instanceof Error ? error.message : "Dominoes match fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/dominoes/match/[matchId]",
      game: "Dominoes",
      metadata: { operation: "fetch_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
