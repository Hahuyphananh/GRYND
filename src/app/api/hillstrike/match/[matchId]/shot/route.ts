// src/app/api/hillstrike/match/[matchId]/shot/route.ts
//
// POST — fire one shot.
//
// The request body carries ONLY:
//
//   { shot: { angleDeg, power }, expectedVersion }
//
// Everything else a client might send — a trajectory, an impact, a hit, a damage
// amount, a life count, a terrain height, a tower layout, whose turn it is, a
// winner, a result, a completion flag — is IGNORED: no such field is read here or
// in the store. The aim is validated by the shared rules engine
// (`validateShot`), resolved by `applyShot`/`simulateShot` inside the store's
// row-locked transaction, and the resulting authoritative state is what both
// clients render. The server never trusts client-side physics.
//
// `expectedVersion` is the optimistic-concurrency token (the match's `ply`): a
// double-submit, a retried request or a stale tab is rejected with a 409 instead
// of consuming a second shot.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import { isMatchId, matchToDto, submitShot } from "../../../../../../lib/hillstrike/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/hillstrike/rooms";

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
    const result = await submitShot({
      userId,
      matchId,
      shot: body?.shot,
      expectedVersion: body?.expectedVersion,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error, code: result.code ?? null },
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
      lives: result.state.lives,
      matchCompleted: result.matchCompleted,
      result: result.match.result ?? null,
      winnerId: result.match.winnerId ?? null,
      resultReason: result.match.resultReason ?? null,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: matchToDto(result.match, userId),
        // The shot the SERVER resolved. The client animates this rather than
        // simulating the outcome itself.
        shot: result.shot,
        actionIndex: result.actionIndex,
        matchCompleted: result.matchCompleted,
        winnerId: result.match.winnerId ?? null,
        result: result.match.result ?? null,
        resultReason: result.match.resultReason ?? null,
      },
    });
  } catch (error) {
    await logError({
      errorType: "hillstrike_shot_error",
      errorMessage:
        error instanceof Error ? error.message : "Hillstrike shot failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/hillstrike/match/[matchId]/shot",
      game: "Hillstrike",
      metadata: { operation: "shot" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
