// src/app/api/solitaire-puzzle/session/[sessionId]/move/route.ts
//
// POST — take one move in a puzzle session.
//
// The body carries ONLY `{ move, expectedPly }`:
//
//   move         — which cards, from where, to where. Shape-checked WITHOUT
//                  coercion by `normalizeMove`, then re-derived against the
//                  server's stored board.
//   expectedPly  — the acting seat's own move cursor. It must equal the stored
//                  ply, so a double-submit or a stale tab cannot apply twice.
//
// Everything else a client might send — a board, a start state, a stock order,
// a solved count, a progress figure, a completion flag, a completion instant, a
// deadline, a score, a winner or a result — is not read here or in the store.
//
// Rejections are surfaced verbatim: 400 malformed, 403 not a participant,
// 404 unknown session, 409 lifecycle/staleness/deadline conflict, 422 a
// well-formed but illegal Klondike move, 500 unexpected.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { recordStreakCompletion } from "../../../../../../lib/streaks/server";
import {
  isPuzzleSessionId,
  submitPuzzleMove,
} from "../../../../../../lib/solitaire-puzzle/serverStore";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await submitPuzzleMove({
      userId,
      sessionId,
      // The ONLY two client-authored values that reach the store.
      move: body?.move,
      expectedPly: body?.expectedPly as number | undefined,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    // UTC DAILY STREAK: finishing a puzzle session credits today once, for
    // every mode (ranked and vs-AI alike). A failure here must never fail the
    // move that was already applied.
    let streak: Awaited<ReturnType<typeof recordStreakCompletion>> = null;
    if (result.finished) {
      try {
        streak = await recordStreakCompletion(userId);
      } catch {
        streak = null;
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        // The authoritative post-move projection for the acting seat.
        session: result.view,
        // Cards this move legitimately turned face-up. A view strips face-down
        // identities, so this is the only way a flip can be rendered — and the
        // server is the only thing that can name them.
        revealed: result.revealed,
        moveStatus: result.moveStatus,
        advancedPuzzle: result.advancedPuzzle,
        completedSession: result.completedSession,
        finished: result.finished,
        streak,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_puzzle_move_error",
      errorMessage:
        error instanceof Error ? error.message : "Puzzle session move failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-puzzle/session/[sessionId]/move",
      game: "Solitaire Puzzle",
      metadata: { operation: "move" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
