// src/app/api/solitaire-duel/match/[matchId]/route.ts
//
// GET — the authoritative Solitaire Duel snapshot for one participant.
//
// This is the client's ONE read path: the lobby's poll, the match view's
// poll backstop, the post-move resync and the post-reconnect reconstruction all
// come through here, so there is exactly one place the board can arrive from.
//
// WHAT IT CARRIES: the viewer's OWN projected board (`view` — face-down
// positions stripped of identity, the stock reduced to a count), the viewer's
// own progress, the opponent's CLOSED progress shape, and the server's clock
// (plus the absolute GO/deadline instants a countdown and a timer are derived
// from). It never carries the opponent's board, the stock order, a face-down
// identity or the server seed (the seed is only revealed once the match is
// terminal, so the deal can be verified after the fact).
//
// Authorisation: `fetchMatch` refuses a non-participant with a 403, so a leaked
// match id exposes nothing. The caller's id comes from the verified session,
// never from the URL, the body or a query string.
//
// A match past its deadline is resolved ON READ (the store does that), so a
// race is never left live just because nobody happened to move — which is also
// how the client receives the authoritative timeout result without ever
// deciding it locally.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../lib/logError";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import { fetchMatch, isMatchId } from "../../../../../lib/solitaire-duel/serverStore";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  // Guard the uuid before it can reach a Postgres uuid cast, so a malformed id
  // is a 400 rather than a 500 from the driver.
  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
  }

  try {
    const result = await fetchMatch({ userId, matchId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // Seat identity is an ADORNMENT for the opponent panel (name, icon, frame
    // colour). It is read through the platform's shared resolver, and a failure
    // here must never fail the match payload — the board is what matters.
    let players = null;
    try {
      players = await getSeatIdentity(
        result.match.player1Id,
        result.match.player2Id ?? null,
      );
    } catch {
      players = null;
    }

    return NextResponse.json({
      success: true,
      data: {
        ...result.dto,
        // The opponent panel's identity. Cosmetic only: it carries no rules, no
        // board and no outcome, and `matchToDto` itself stays exactly as the
        // store defines it.
        players,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_match_fetch_error",
      errorMessage: error instanceof Error ? error.message : "Solitaire Duel fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]",
      game: "Solitaire Duel",
      metadata: { operation: "fetch_match" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
