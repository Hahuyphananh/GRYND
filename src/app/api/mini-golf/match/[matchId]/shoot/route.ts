// src/app/api/mini-golf/match/[matchId]/shoot/route.ts
//
// POST — take one shot.
//
// The request body carries ONLY { angle, power, expectedVersion }. Anything
// else a client might send (a ball position, a stroke count, a hole winner, a
// match winner) is ignored: the sequence is
//   validateShot → simulateShot → applyShot
// entirely inside the server store's row-locked transaction.
//
// `expectedVersion` is the optimistic-concurrency token: it must equal the
// match's current `state.version`, so a double-submit or a stale tab cannot
// apply a second shot. Omitting it is allowed (the turn + holed-out checks
// still hold), but the client always sends it.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  shoot,
} from "../../../../../../lib/mini-golf/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/mini-golf/rooms";

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
    const result = await shoot({
      userId,
      matchId,
      angle: body?.angle,
      power: body?.power,
      expectedVersion: body?.expectedVersion,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Both seats are told the same authoritative summary. The trajectory
    // itself is fetched from the snapshot (`lastShot.result`) rather than
    // pushed here, so the payload stays a light invalidation hint and the
    // client never animates anything the server did not produce.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      version: result.state.version,
      currentHole: result.state.currentHole,
      currentTurn: result.state.currentTurn,
      shotSeq: result.state.shotSeq,
      holeCompleted: result.holeCompleted,
      matchCompleted: result.matchCompleted,
      holeWinner: result.holeWinner,
      // Ordered lifecycle transitions (SHOT_RESOLVING → BALL_SETTLED → …).
      stages: result.stages,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: matchToDto(result.match, userId),
        // Full deterministic trajectory so the client can replay the exact
        // movement the server computed (never one it invented).
        shot: result.shotResult,
        holeCompleted: result.holeCompleted,
        matchCompleted: result.matchCompleted,
        holeWinner: result.holeWinner,
        stages: result.stages,
      },
    });
  } catch (error) {
    await logError({
      errorType: "mini_golf_shoot_error",
      errorMessage:
        error instanceof Error ? error.message : "Mini Golf shot failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/mini-golf/match/[matchId]/shoot",
      game: "Mini Golf",
      metadata: { operation: "shoot" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
