// src/app/api/hillstrike/match/[matchId]/shot/route.ts
//
// POST — take one action: fire or drive.
//
// The request body carries ONLY:
//
//   { action: { type: "shoot", angleDeg, power }, expectedVersion }
//   { action: { type: "move", direction: "forward" | "back" }, expectedVersion }
//
// There is no build action: the only structures on the board are the two base
// roofs and the middle tower, and both are dealt by the generator.
//
// Everything else a client might send — a trajectory, an impact, a hit, a damage
// amount, an HP total, a block id, a terrain height, a tower layout, whose turn
// it is, a winner, a result, a completion flag — is IGNORED: no such field is
// read here or in the store. The action is validated by the shared rules
// engine (`validateAction`), resolved by `applyAction`/`simulateShot` inside the
// store's row-locked transaction, and the resulting authoritative state is what
// both clients render. The server never trusts client-side physics.
//
// `expectedVersion` is the optimistic-concurrency token (the match's `ply`): a
// double-submit, a retried request or a stale tab is rejected with a 409 instead
// of consuming a second action.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import { isMatchId, matchToDto, submitAction } from "../../../../../../lib/hillstrike/serverStore";
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
    // `shot` is the v1 body shape (a bare aim); it is accepted as the `shoot`
    // action so an already-open tab keeps working, and it can never mean
    // anything else — the engine re-derives its type from the action itself.
    const action =
      body?.action ??
      (body?.shot && typeof body.shot === "object"
        ? { ...(body.shot as Record<string, unknown>), type: "shoot" }
        : undefined);

    const result = await submitAction({
      userId,
      matchId,
      action,
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
      hp: result.state.hp,
      matchCompleted: result.matchCompleted,
      result: result.match.result ?? null,
      winnerId: result.match.winnerId ?? null,
      resultReason: result.match.resultReason ?? null,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: matchToDto(result.match, userId),
        // The action the SERVER resolved. The client animates this rather than
        // simulating the outcome itself.
        action: result.action,
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
