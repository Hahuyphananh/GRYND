// src/app/api/sudoku-duel/match/[matchId]/move/route.ts
//
// POST — take one Sudoku Duel action.
//
// The request body carries ONLY `{ action, expectedPly }`:
//
//   action       — "place value V at cell I" or "clear cell I". Shape-checked
//                  without coercion inside the store (`normalizeAction`), then
//                  judged against the SERVER's puzzle and solution.
//   expectedPly  — the per-seat idempotency cursor. It must equal the acting
//                  seat's own ply, so a double-submit or a stale tab cannot apply
//                  a second action.
//
// Everything else a client might send — a board, a solution, a correct-cell
// count, a progress figure, a mistake count, a completion flag, a completion
// instant, a score, a winner, a result, an Elo delta, a trophy — is not read at
// any point of this route or the store behind it.
//
// The response distinguishes the two legal outcomes of a placement:
//   correct: true   → the cell was filled; verified progress advanced
//   correct: false  → the value was WRONG; it was not written, the answer was NOT
//                     revealed, and the mistake/penalty counters advanced
// A refusal (a clue cell, an out-of-range value, a stale ply) is a non-2xx error.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  puzzleForMatch,
  seatsFromRow,
  stateForSeat,
  submitMove,
} from "../../../../../../lib/sudoku-duel/serverStore";
import { seatForUser } from "../../../../../../lib/sudoku-duel/rules";
import { broadcastMatchUpdate } from "../../../../../../lib/sudoku-duel/rooms";
import {
  broadcastMatchFinished,
  broadcastOpponentProgress,
} from "../../../../../../lib/sudoku-duel/realtime";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }

  const resolved = (await params) || ({} as { matchId?: string });
  const matchId = resolved.matchId;
  if (!isMatchId(matchId)) {
    return NextResponse.json({ success: false, error: "Invalid matchId" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await submitMove({
      userId,
      matchId,
      // The ONLY two client-authored values that reach the store.
      action: body?.action,
      expectedPly: body?.expectedPly,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    const seat = seatForUser(seatsFromRow(result.match), userId);
    const nowMs = Date.now();

    // The opponent's live progress: projected by the store's own rules module
    // from the seat's STORED board, so it can only ever contain counts the server
    // derived. Coalesced by the realtime layer, and always recoverable from the
    // snapshot the receiving client re-fetches.
    if (seat) {
      const puzzle = puzzleForMatch(result.match);
      broadcastOpponentProgress({
        matchId,
        seat,
        puzzle: puzzle.puzzle,
        solution: puzzle.solution,
        state: stateForSeat(result.match, seat),
        nowMs,
      });
    }

    // A bare invalidation hint for the other seat (status + the acting seat's
    // ply + whether progress advanced). No board travels here.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      ply: result.ply,
      correct: result.correct === true,
      completed: result.completed === true,
      result: result.match.result ?? null,
    });

    if (result.raceResolved) {
      broadcastMatchFinished({
        matchId,
        status: result.match.status,
        result: result.match.result,
        winnerId: result.match.winnerId,
        resolutionReason: result.match.resolutionReason,
        endedAtMs: result.match.endedAt ? new Date(result.match.endedAt).getTime() : null,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        // The AUTHORITATIVE post-action snapshot for the acting seat.
        match: matchToDto(result.match, userId, nowMs),
        // What the server decided about the submitted action. `correct: false`
        // means a WRONG value: it was not written and the answer is never in this
        // payload.
        verdict: result.verdict,
        correct: result.correct === true,
        progress: result.progress,
        completed: result.completed === true,
        raceResolved: result.raceResolved === true,
      },
    });
  } catch (error) {
    await logError({
      errorType: "sudoku_duel_move_error",
      errorMessage: error instanceof Error ? error.message : "Sudoku Duel action failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/sudoku-duel/match/[matchId]/move",
      game: "Sudoku Duel",
      metadata: { operation: "move" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
