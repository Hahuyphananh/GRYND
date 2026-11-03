// src/app/api/battleship/practice/[matchId]/attack/route.ts
//
// POST — lock the human's attack in a PRACTICE match. `{ coordinate }` only.
//
// The bot's lock for the round was committed by the STORE before this request
// existed (at combat start, and again after each resolved round), so the round
// resolves here with both shots — the same simultaneous path ranked play uses.
// Publication is identical: a result is broadcast only after the transaction
// committed.

import { NextResponse } from "next/server";

import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { logError } from "../../../../../../lib/logError";
import { isMatchId, submitAttack } from "../../../../../../lib/battleship/serverStore";
import {
  BATTLESHIP_EVENTS,
  broadcastBattleshipEvent,
  broadcastMatchUpdate,
} from "../../../../../../lib/battleship/rooms";
import { publishRoundResult } from "../../../../../../lib/battleship/publish";

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

  const body = (await req.json().catch(() => ({}))) as { coordinate?: unknown };

  try {
    const result = await submitAttack({ userId, matchId, coordinate: body?.coordinate });
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }
    if (result.dto.isAi !== true) {
      return NextResponse.json(
        { success: false, error: "This is not a practice match" },
        { status: 403 },
      );
    }

    // ── Committed. Only now is anything published. ──────────────────────
    broadcastMatchUpdate(matchId, { phase: result.dto.phase, round: result.dto.round });

    if (result.status === "waiting") {
      broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.ATTACK_LOCKED, {
        round: result.dto.round,
        seat: result.dto.you.seat,
      });
      return NextResponse.json({
        success: true,
        data: { ...result.dto, locked: true, resolved: null },
      });
    }

    const round = result.round;
    if (round.automaticSeats.length > 0) {
      broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.ATTACK_TIMEOUT, {
        round: round.round,
        seats: round.automaticSeats,
      });
    }
    publishRoundResult(matchId, round);

    return NextResponse.json({
      success: true,
      data: { ...result.dto, locked: true, resolved: round },
    });
  } catch (error) {
    await logError({
      errorType: "battleship_practice_attack_error",
      errorMessage:
        error instanceof Error ? error.message : "Battleship practice attack failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/practice/[matchId]/attack",
      game: "Battleship",
      metadata: { operation: "practice_submit_attack" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
