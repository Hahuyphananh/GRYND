// src/app/api/dominoes/match/[matchId]/move/route.ts
//
// POST — take one action. There are exactly three, and the request body says
// which one was MEANT, never what it did:
//
//   { action: { type: "play", tile: "6-3", end: "left" | "right" },
//     expectedVersion }
//   { action: { type: "draw" }, expectedVersion }
//   { action: { type: "pass" }, expectedVersion }
//
// Everything else a client might send — a hand, the chain, an open end, whose
// turn it is, a pips total, a winner, a result, a completion flag, an Elo delta
// — is IGNORED: no such field is read here or in the store. Legality is decided
// by the shared rules engine (`validateAction`) and applied by `applyAction`
// inside the store's row-locked transaction, so the server decides every
// consequence, including whether drawing or passing is legal at all.
//
// `expectedVersion` is REQUIRED here (the match's `ply`): a draw keeps the turn,
// so an unversioned retried draw would silently consume a second tile. A
// double-submit, a retried request or a stale tab is a 409, and a request that
// arrives after this turn's 15-second window is refused while the clock is
// advanced in the same transaction.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  move,
} from "../../../../../../lib/dominoes/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/dominoes/rooms";

export async function POST(
  req: Request,
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  try {
    const result = await move({
      userId,
      matchId,
      action: body?.action,
      expectedVersion: body?.expectedVersion,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Both seats are told the same authoritative summary. The position is NOT
    // pushed: the payload is a light invalidation hint, and each client renders
    // from the projection it re-reads. No hand, no count, no pile.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      version: result.match.ply,
      currentTurnUserId: result.match.currentTurnUserId ?? null,
      ply: result.match.ply,
      matchCompleted: result.matchCompleted,
      result: result.match.result ?? null,
      winnerId: result.match.winnerId ?? null,
      resultReason: result.match.resultReason ?? null,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: matchToDto(result.match, userId),
        // Echo of the action the SERVER applied, for the client's move log.
        action: {
          type: result.state.lastAction?.action.type ?? null,
          ply: result.ply,
          timedOut: false,
        },
        matchCompleted: result.matchCompleted,
        winnerId: result.match.winnerId ?? null,
        result: result.match.result ?? null,
        resultReason: result.match.resultReason ?? null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "dominoes_move_error",
      errorMessage:
        error instanceof Error ? error.message : "Dominoes action failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/dominoes/match/[matchId]/move",
      game: "Dominoes",
      metadata: { operation: "move" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
