// src/app/api/hillstrike/match/[matchId]/route.ts
//
// GET — the authoritative match snapshot for the calling participant.
//
// The DTO is the viewer-projected projection from the server store, so the client
// never has to re-derive whose turn it is, how many shots the active seat has
// left in its volley, or whether the match is over. Non-participants get a 403 —
// Hillstrike online has no spectator mode, and this is also what stops an
// unrelated account from reading another player's match.
//
// There is no clock and no deadline resolution: a read can never change the
// match, so this route is a pure projection. This is also the RECONNECT path — a
// refreshed tab or a new device re-reads the same authoritative row.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  fetchMatch,
  fetchMatchShots,
  isMatchId,
} from "../../../../../lib/hillstrike/serverStore";

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

    // Shot history + seat identity are adornments: a failure here must not fail
    // the match payload, because the board renders from the snapshot alone.
    let shots: unknown[] = [];
    try {
      shots = await fetchMatchShots(matchId);
    } catch {
      shots = [];
    }

    let players = null;
    try {
      players = await getSeatIdentity(match.player1Id, match.player2Id ?? null);
    } catch {
      players = null;
    }

    return NextResponse.json({
      success: true,
      data: {
        ...result.dto,
        players,
        shots,
      },
    });
  } catch (error) {
    await logError({
      errorType: "hillstrike_match_fetch_error",
      errorMessage:
        error instanceof Error ? error.message : "Hillstrike match fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/hillstrike/match/[matchId]",
      game: "Hillstrike",
      metadata: { operation: "fetch_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
