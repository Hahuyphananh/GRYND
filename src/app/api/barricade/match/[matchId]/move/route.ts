// src/app/api/barricade/match/[matchId]/move/route.ts
//
// POST — take one action (move the pawn, or place a barricade).
//
// The request body carries ONLY:
//
//   { action: { type: "move", to: { col, row } }
//           | { type: "wall", wall: { col, row, orientation } },
//     expectedVersion }
//
// Everything else a client might send — a board, a pawn position, a barricade
// list, a remaining-wall count, whose turn it is, a winner, a result, a
// completion flag — is IGNORED: no such field is read here or in the store. The
// address is validated by the shared rules engine (`validateAction`) and applied
// by `applyAction` inside the store's row-locked transaction, so the server
// decides every consequence.
//
// `expectedVersion` is the optimistic-concurrency token (the match's `ply`): a
// double-submit, a retried request or a stale tab is rejected with a 409 instead
// of consuming a second turn.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  move,
} from "../../../../../../lib/barricade/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/barricade/rooms";

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
    // from the snapshot it re-reads.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      version: result.match.ply,
      currentTurnUserId: result.match.currentTurnUserId,
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
          type: result.kind ? "move" : "wall",
          ply: result.ply,
          kind: result.kind,
        },
        matchCompleted: result.matchCompleted,
        winnerId: result.match.winnerId ?? null,
        result: result.match.result ?? null,
        resultReason: result.match.resultReason ?? null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "barricade_move_error",
      errorMessage:
        error instanceof Error ? error.message : "Barricade action failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/barricade/match/[matchId]/move",
      game: "Barricade",
      metadata: { operation: "move" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
