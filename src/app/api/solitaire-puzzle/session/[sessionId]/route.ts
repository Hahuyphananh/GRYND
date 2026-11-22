// src/app/api/solitaire-puzzle/session/[sessionId]/route.ts
//
// GET — the sanitized, authoritative puzzle-session snapshot for one seat.
//
// WHAT IT RETURNS: `PuzzleSessionView`, built field-by-field in
// src/lib/solitaire-puzzle/projection.ts. That shape carries the viewer's OWN
// projected board (face-down slots have `card: null`, the stock is a count and
// `nextStockCard` is always null), the public objective, the progress meter,
// both solved counts, the shared clock instants and the settled result.
//
// WHAT IT NEVER RETURNS: the stored manifest (hidden start states, stock
// order), the opponent's board, the selection seed, any accepted solution
// path, verification metadata or internal validation data. The projection does
// not spread a row or a spec — see the module header for why.
//
// Authorisation: `fetchPuzzleSession` resolves the caller's seat from the
// signed session and refuses a non-participant with a 403, so a leaked session
// id exposes nothing. The caller's id is never taken from the URL or body.
//
// There is deliberately NO create route in this phase: matchmaking and AI
// opponent selection are later work, so sessions are minted server-side.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../lib/auth/guestSession";
import { logError } from "../../../../../lib/logError";
import { fetchPuzzleSession, isPuzzleSessionId } from "../../../../../lib/solitaire-puzzle/serverStore";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const resolved = (await params) || ({} as { sessionId?: string });
  const sessionId = resolved.sessionId;
  if (!isPuzzleSessionId(sessionId)) {
    return NextResponse.json({ success: false, error: "Invalid sessionId" }, { status: 400 });
  }

  try {
    const result = await fetchPuzzleSession({ userId, sessionId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    // The view is the entire payload: nothing is added here, so this route
    // cannot widen the client boundary by accident.
    return NextResponse.json({ success: true, data: result.view });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_session_fetch_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle session fetch failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/session/[sessionId]",
      game: "Solitaire Puzzle",
      metadata: { operation: "fetch_session" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
