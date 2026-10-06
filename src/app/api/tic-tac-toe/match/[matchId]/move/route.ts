// src/app/api/tic-tac-toe/match/[matchId]/move/route.ts
//
// POST — place one mark.
//
// The request body carries ONLY { boardIndex, cellIndex, expectedVersion }.
// Everything else a client might send (a mark, a board, a winner, a result, a
// score, a stage/round, whose turn it is, an Elo value, a trophy, a completion
// flag) is IGNORED: the sequence
//   validateMove → applyMove
// runs entirely inside the server store's row-locked transaction, and this
// route only ever forwards the three fields below.
//
// `boardIndex` is a lattice slot (0..8), or the sudden-death sentinel (-1)
// while sudden death is live. The store's `validateMove` rejects a slot that is
// not in play at the current stage, so the client can never address a board the
// server has not materialised.
//
// `expectedVersion` is the optimistic-concurrency token: it must equal the
// match's current `state.version`, so a double-submit or a stale tab cannot
// apply a second move. Omitting it is allowed (the turn and occupancy checks
// still hold), but the client always sends it.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  move,
} from "../../../../../../lib/tic-tac-toe/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/tic-tac-toe/rooms";

export async function POST(
  req: Request,
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
      boardIndex: body?.boardIndex,
      cellIndex: body?.cellIndex,
      expectedVersion: body?.expectedVersion,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Both seats are told the same authoritative summary. The board itself is
    // NOT pushed: the payload is a light invalidation hint, and the client
    // always renders from the snapshot below.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      version: result.state.version,
      currentTurnUserId: result.match.currentTurnUserId,
      ply: result.state.ply,
      // The stage is a hint that an expansion just happened, so the opponent's
      // refetch knows to expect the wider lattice. The boards themselves are
      // never pushed — the snapshot is always the source of truth.
      stage: result.state.stage,
      matchCompleted: result.matchCompleted,
      result: result.match.result ?? null,
      winnerId: result.match.winnerId ?? null,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: matchToDto(result.match, userId),
        // Echo of the move the SERVER applied (derived from the acting seat),
        // for the client's move-history panel.
        move: {
          boardIndex: result.state.lastMove?.boardIndex ?? null,
          cellIndex: result.state.lastMove?.cellIndex ?? null,
          mark: result.mark,
          ply: result.ply,
        },
        matchCompleted: result.matchCompleted,
        winningLine: result.winningLine,
        winningBoards: result.winningBoards,
        stage: result.stage,
        winnerId: result.match.winnerId ?? null,
        result: result.match.result ?? null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "tic_tac_toe_move_error",
      errorMessage:
        error instanceof Error ? error.message : "Tic-Tac-Toe move failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/tic-tac-toe/match/[matchId]/move",
      game: "Tic-Tac-Toe",
      metadata: { operation: "move" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
