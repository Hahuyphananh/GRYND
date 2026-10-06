// src/app/api/speed-typing/match/[matchId]/progress/route.ts
//
// POST — submit a typing CHECKPOINT.
//
// The request body carries ONE field: `typedText`, the caller's current typing
// buffer. Everything the platform knows about progress — how many characters
// are correct, how many are wrong, whether the seat is done, its WPM and its
// accuracy — is derived by the store from the SERVER's passage. A request that
// also carries `wpm`, `accuracy`, `winner` or anything similar is simply
// ignored: `recordProgress` reads only the user, the match and the text.
//
// The store itself throttles: a checkpoint below `PROGRESS_MIN_ADVANCE` is a
// no-op with NO database write, which is why a client can send at keystroke
// cadence without turning a race into a write storm.
//
// After an ACCEPTED checkpoint the server broadcasts the opponent's projected
// progress (never the raw text) and a generic invalidation, so the other seat's
// UI updates in ~50 ms instead of on the next poll.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { isMatchId, recordProgress } from "../../../../../../lib/speed-typing/serverStore";
import { passageForRow } from "../../../../../../lib/speed-typing/passages";
import { instantFromDate } from "../../../../../../lib/speed-typing/rules";
import {
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
    const result = await recordProgress({
      userId,
      matchId,
      // The ONLY client-authored value that reaches the store.
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
      // Derived from the STORED seat state, never from the request.
      broadcastOpponentProgress({
        matchId,
        seatKey: result.seat,
        seat: result.seatState,
        promptLength: passage?.charCount ?? 0,
        nowMs,
        goAtMs: instantFromDate(result.match.goAt),
      });
      broadcastMatchUpdate(matchId, {
        status: result.match.status,
        revision: Number(result.match.revision ?? 0),
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        accepted: result.accepted,
        reason: result.reason,
        // The server's own position, so a client can reconcile instead of
        // trusting its local buffer.
        seat: result.seatState,
        revision: Number(result.match.revision ?? 0),
      },
    });
  } catch (error) {
    await logError({
      errorType: "speed_typing_progress_error",
      errorMessage:
        error instanceof Error ? error.message : "Speed Typing checkpoint failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/speed-typing/match/[matchId]/progress",
      game: "Speed Typing",
      metadata: { operation: "record_progress" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
