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

    return NextResponse.json({
      success: true,
      data: { match: result.dto },
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
