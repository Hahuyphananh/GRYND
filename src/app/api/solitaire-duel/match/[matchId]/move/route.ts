// src/app/api/solitaire-duel/match/[matchId]/move/route.ts
//
// POST — take one Solitaire Duel move.
//
// The request body carries ONLY `{ move, expectedPly }`:
//
//   move         — which cards, from where, to where. Shape-checked without
//                  coercion inside the store (`normalizeMove`), then re-derived
//                  against the SERVER's board.
//   expectedPly  — the per-seat idempotency cursor. It must equal the acting
//                  seat's own ply, so a double-submit or a stale tab cannot
//                  apply a second move.
//
// Everything else a client might send — a board, a tableau, foundations, a
// progress figure, a completion flag, a completion instant, a score, a winner,
// a result, an Elo delta, a trophy — is not read at any point of this route or
// the store behind it. The board, the stock order, the face-up/face-down state,
// the progress, the completion instant, the winner and the settlement are all
// derived server-side from the stored state.
//
// Rejections are surfaced verbatim (409 for a lifecycle/staleness conflict, 422
// for a well-formed but illegal Klondike move) so the client can show an
// unobtrusive notice and resync instead of guessing what happened.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import {
  isMatchId,
  matchToDto,
  seatsFromRow,
  stateForSeat,
  submitMove,
} from "../../../../../../lib/solitaire-duel/serverStore";
import { seatForUser } from "../../../../../../lib/solitaire-duel/rules";
import { broadcastMatchUpdate } from "../../../../../../lib/solitaire-duel/rooms";
import {
  broadcastMatchFinished,
  broadcastOpponentProgress,
} from "../../../../../../lib/solitaire-duel/realtime";

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
      move: body?.move,
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
    // from the seat's STORED board, so it can only ever contain counts the
    // server derived. Coalesced by the realtime layer, and always recoverable
    // from the snapshot the receiving client re-fetches.
    if (seat) {
      broadcastOpponentProgress({
        matchId,
        seat,
        state: stateForSeat(result.match, seat),
        nowMs,
      });
    }

    // A bare invalidation hint for the other seat (status + the acting seat's
    // ply). No board travels here — the client always renders the snapshot.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      ply: result.ply,
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
        // The AUTHORITATIVE post-move snapshot for the acting seat, so the
        // client can render the resulting state from one round trip.
        match: matchToDto(result.match, userId, nowMs),
        // The cards this move turned face-up. A client's view strips face-down
        // identities, so this is the only way the flip can be rendered — and
        // the server is the only thing that can name them.
        revealed: result.revealed ?? [],
        completed: result.completed === true,
        raceResolved: result.raceResolved === true,
      },
    });
  } catch (error) {
    await logError({
      errorType: "solitaire_duel_move_error",
      errorMessage: error instanceof Error ? error.message : "Solitaire Duel move failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/solitaire-duel/match/[matchId]/move",
      game: "Solitaire Duel",
      metadata: { operation: "move" },
    });
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}