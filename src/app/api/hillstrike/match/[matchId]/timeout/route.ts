// src/app/api/hillstrike/match/[matchId]/timeout/route.ts
//
// POST — resolve a match whose CLOCK has run out.
//
// The match view calls this when its countdown reaches zero (both seats will, and
// that is fine: the store settles under a row lock and the conditional
// `status = 'playing'` UPDATE, so the second caller gets the same terminal row).
//
// The clock is the SERVER's: the store checks `started_at + duration_ms` against
// its own clock, so a client that asks early gets a 409 rather than a verdict.
// The verdict itself is the engine's `finishOnTime` — the tank with more HP wins,
// and level HP records a draw (`result: null`, reason `timed-out`), which settles
// no rating and no trophy.
//
// The request body is ignored: there is nothing a client could say about who won.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  resolveTimeout,
} from "../../../../../../lib/hillstrike/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/hillstrike/rooms";

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
    const result = await resolveTimeout({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Best-effort push: the other seat re-reads the terminal snapshot instead of
    // waiting for its own countdown.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      version: result.match.ply,
      result: result.match.result ?? null,
      winnerId: result.match.winnerId ?? null,
      resultReason: result.match.resultReason ?? null,
      timedOut: true,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: matchToDto(result.match, userId),
        timedOut: result.expired,
        winnerSeat: result.winnerSeat,
      },
    });
  } catch (error) {
    await logError({
      errorType: "hillstrike_timeout_error",
      errorMessage:
        error instanceof Error ? error.message : "Hillstrike clock resolution failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/hillstrike/match/[matchId]/timeout",
      game: "Hillstrike",
      metadata: { operation: "timeout" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
