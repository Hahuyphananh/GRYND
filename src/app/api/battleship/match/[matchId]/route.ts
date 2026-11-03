// src/app/api/battleship/match/[matchId]/route.ts
//
// GET — the authoritative snapshot for the calling participant.
//
// The DTO is the store's whitelist projection: phase, round, readiness, clocks
// and the VIEWER'S OWN fleet. A non-participant gets a 403, and the opponent's
// fleet is never selected, so this route cannot leak hidden ship positions even
// if a client asks for them. A read never changes the match.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import { fetchMatch, isMatchId } from "../../../../../lib/battleship/serverStore";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  publishForfeit,
  publishRoundResult,
  publishTimeoutNotice,
} from "../../../../../lib/battleship/publish";

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

    // Seat identity is an adornment: a failure here must not fail the snapshot.
    let players = null;
    try {
      players = await getSeatIdentity(
        result.dto.seats.player1Id,
        result.dto.seats.player2Id ?? null,
      );
    } catch {
      players = null;
    }

    // A lazy recovery settled a deadline during this read: publish it exactly as
    // the sweep would, so both seats learn about the timeout immediately.
    for (const event of result.events ?? []) {
      if (event.kind === "round_resolved") publishRoundResult(event.matchId, event.round);
      else if (event.kind === "attack_timeout") {
        publishTimeoutNotice(event.matchId, event.round, event.seats);
      } else publishForfeit(event);
    }

    return NextResponse.json({ success: true, data: { ...result.dto, players } });
  } catch (error) {
    await logError({
      errorType: "battleship_match_fetch_error",
      errorMessage: error instanceof Error ? error.message : "Battleship match fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/match/[matchId]",
      game: "Battleship",
      metadata: { operation: "fetch_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
