// src/app/api/battleship/match/[matchId]/fleet/route.ts
//
// POST — confirm this player's fleet.
//
// The ONLY player-authored value this route accepts is the placement list. It
// reads no phase, no seat, no player id, no readiness flag and no result from the
// body: those come from the Clerk gate and the authoritative row. The store
// validates the fleet with the pure engine, writes it once per seat and moves the
// match to COMBAT only when BOTH fleets are confirmed — so a client cannot open
// combat early, and no attack exists in this phase at all.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import { confirmFleet, isMatchId } from "../../../../../../lib/battleship/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/battleship/rooms";

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

  const body = (await req.json().catch(() => ({}))) as { ships?: unknown };
  if (!Array.isArray(body?.ships)) {
    return NextResponse.json(
      { success: false, error: "ships must be an array of ship placements" },
      { status: 400 },
    );
  }

  try {
    const result = await confirmFleet({ userId, matchId, ships: body.ships });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    broadcastMatchUpdate(matchId, {
      phase: result.dto.phase,
      round: result.dto.round,
      seat: result.dto.you.seat,
    });

    return NextResponse.json({
      success: true,
      data: {
        ...result.dto,
        // True when this call was a repeat confirmation (no second write).
        confirmed: result.confirmed,
      },
    });
  } catch (error) {
    await logError({
      errorType: "battleship_fleet_confirm_error",
      errorMessage: error instanceof Error ? error.message : "Battleship fleet confirm failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/match/[matchId]/fleet",
      game: "Battleship",
      metadata: { operation: "confirm_fleet" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
