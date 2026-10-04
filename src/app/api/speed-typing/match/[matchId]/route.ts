// src/app/api/speed-typing/match/[matchId]/route.ts
//
// GET — the authoritative Speed Typing match snapshot for one participant.
//
// This is the read path only. It returns the match's identity and lifecycle
// (status, seats, result) and nothing else — the race's own state (the shared
// passage, the GO instant, per-seat progress) arrives with the gameplay phase
// and will be added to the DTO there.
//
// Authorisation: `fetchMatch` refuses a non-participant with a 403, so a match
// id leaking to a third party exposes nothing. `requireAgeVerifiedUser` gates
// the route before any database work, and the caller's id is taken from the
// verified session — never from the URL, the body or a query string.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import { fetchMatch, isMatchId } from "../../../../../lib/speed-typing/serverStore";

export const dynamic = "force-dynamic";

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

  // Guard the uuid before it can reach a Postgres uuid cast, so a malformed id
  // is a 400 rather than a 500 from the driver.
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

    // Seat identity is an ADORNMENT for the two racers' name plates (username,
    // official icon, equipped frame/name colour). It is read through the
    // platform's SHARED resolver — the same one every other 1v1 board uses — and
    // a failure here must never fail the match payload: the race is what
    // matters, and the client falls back to its own labels.
    //
    // The bot seat (a sentinel id with no `users` row) resolves to null, which
    // is what lets the client render the GRYND mark for it.
    let seatIdentities = null;
    try {
      seatIdentities = await getSeatIdentity(
        result.match.player1Id,
        result.match.player2Id ?? null,
      );
    } catch {
      seatIdentities = null;
    }

    return NextResponse.json({
      success: true,
      data: {
        match: result.dto,
        // Cosmetic only: it carries no rules, no passage and no outcome, and
        // `matchViewFor` itself stays exactly as the store defines it. It is
        // NOT part of `match` — the race DTO's own `players` array (seat ids) is
        // a different, authoritative shape that tests pin.
        seatIdentities,
      },
    });
  } catch (error) {
    await logError({
      errorType: "speed_typing_match_fetch_error",
      errorMessage:
        error instanceof Error ? error.message : "Speed Typing match fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/speed-typing/match/[matchId]",
      game: "Speed Typing",
      metadata: { operation: "fetch_match" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
