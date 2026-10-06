// src/app/api/speed-typing/match/[matchId]/finish/route.ts
//
// POST — claim a FINISH.
//
// The body carries ONE field: `typedText`. The store verifies it against the
// passage IT resolved for the match and, only if that submission is the whole
// prompt exactly, freezes the seat's finish instant, elapsed time, WPM and
// accuracy from the server's own clock. Nothing a client sends can declare a
// winner, a time or a rating.
//
// The second verified finish resolves the race and settles it (rating +
// trophies) inside the same row-locked transaction, so a replayed or retried
// request is a `duplicate` with no second settlement. This route only reports
// that verdict and broadcasts it.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { isMatchId, submitFinish } from "../../../../../../lib/speed-typing/serverStore";
import { passageForRow } from "../../../../../../lib/speed-typing/passages";
import { instantFromDate } from "../../../../../../lib/speed-typing/rules";
import {
  SPEED_TYPING_EVENTS,
  broadcastMatchEvent,
  broadcastMatchUpdate,
  broadcastOpponentProgress,
} from "../../../../../../lib/speed-typing/realtime";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ matchId: string }> },
) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;
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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  try {
    const result = await submitFinish({
      userId,
      matchId,
      typedText: body?.typedText,
    });

    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    if (result.accepted) {
      const passage = passageForRow(result.match);
      const nowMs = Date.now();

      // Both seats are told the same authoritative facts. `PLAYER_COMPLETED`
      // carries the seat's frozen server numbers; only the seat itself can act
      // on them, and the opponent renders them as "they are done, at X wpm".
      broadcastOpponentProgress({
        matchId,
        seatKey: result.seat,
        seat: result.seatState,
        promptLength: passage?.charCount ?? 0,
        nowMs,
        goAtMs: instantFromDate(result.match.goAt),
      });
      broadcastMatchEvent(matchId, SPEED_TYPING_EVENTS.PLAYER_COMPLETED, {
        seatKey: result.seat,
        finishedAtMs: result.seatState.finishedAtMs,
        elapsedMs: result.seatState.elapsedMs,
        wpm: result.seatState.wpm,
        accuracy: result.seatState.accuracy,
      });
      broadcastMatchUpdate(matchId, {
        status: result.match.status,
        revision: Number(result.match.revision ?? 0),
      });

      // Only the SECOND verified finish resolves the race, so this fires at
      // most once per match — and the settlement it reports already committed
      // in the store's transaction.
      if (result.outcome?.settled) {
        broadcastMatchEvent(matchId, SPEED_TYPING_EVENTS.MATCH_FINISHED, {
          status: result.match.status,
          result: result.match.result,
          winnerId: result.match.winnerId,
          resolutionReason: result.outcome.resolutionReason,
          resolvedAtMs: result.outcome.resolvedAtMs,
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        accepted: result.accepted,
        reason: result.reason,
        seat: result.seatState,
        outcome: result.outcome
          ? {
              settled: result.outcome.settled,
              winnerSeat: result.outcome.winnerSeat,
              resolutionReason: result.outcome.resolutionReason,
            }
          : null,
        revision: Number(result.match.revision ?? 0),
      },
    });
  } catch (error) {
    await logError({
      errorType: "speed_typing_finish_error",
      errorMessage:
        error instanceof Error ? error.message : "Speed Typing finish failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/speed-typing/match/[matchId]/finish",
      game: "Speed Typing",
      metadata: { operation: "submit_finish" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
