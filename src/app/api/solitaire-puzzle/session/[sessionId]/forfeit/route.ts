// src/app/api/solitaire-puzzle/session/[sessionId]/forfeit/route.ts
//
// POST — concede (or abandon) a Puzzle Ranked session.
//
// A LIVE match is settled by the server: the opponent wins, `resolution_reason`
// is `forfeit`, and the normal rated settlement runs once inside the same
// row-locked transaction. A still-waiting search is simply cancelled and settles
// nothing. The body is not read at all — no winner, score, reason or delta is
// accepted from the client.
//
// Idempotent: conceding an already-terminal session returns its current
// sanitized view and never settles twice.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { logError } from "../../../../../../lib/logError";
import { recordStreakCompletion } from "../../../../../../lib/streaks/server";
import {
  forfeitPuzzleSession,
  isPuzzleSessionId,
} from "../../../../../../lib/solitaire-puzzle/serverStore";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const resolved = (await params) || ({} as { sessionId?: string });
  const sessionId = resolved.sessionId;
  if (!isPuzzleSessionId(sessionId)) {
    return NextResponse.json({ success: false, error: "Invalid sessionId" }, { status: 400 });
  }

  try {
    const result = await forfeitPuzzleSession({ userId, sessionId });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    // A forfeit of a LIVE session is still a completed game for the player who
    // conceded. A cancelled search returns no terminal result and credits
    // nothing (the writer is idempotent per UTC day anyway).
    let streak: Awaited<ReturnType<typeof recordStreakCompletion>> = null;
    const view = result.view as { status?: string; result?: unknown } | null;
    if (view && (view.status === "finished" || view.result != null)) {
      try {
        streak = await recordStreakCompletion(userId);
      } catch {
        streak = null;
      }
    }

    return NextResponse.json({ success: true, data: result.view, streak });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_forfeit_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle Ranked forfeit failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/session/[sessionId]/forfeit",
      game: "Puzzle Ranked",
      metadata: { operation: "forfeit" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
