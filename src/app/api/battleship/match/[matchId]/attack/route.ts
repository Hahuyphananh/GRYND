// src/app/api/battleship/match/[matchId]/attack/route.ts
//
// POST — lock this player's attack for the open round.
//
// THE BODY CARRIES EXACTLY ONE THING: `{ coordinate }`. Not a round, not a seat,
// not a hit/miss, not a sunk ship, not a result, not a winner — none of those
// fields is read (or even typed). The store derives the seat from the Clerk gate,
// the round from the row and both outcomes from the engine's simultaneous
// resolution.
//
// PUBLICATION ORDER is the contract: everything below the `await submitAttack`
// runs AFTER the transaction committed, and a round's two results are published
// together. A single locked attack publishes only "locked" — no coordinate, no
// result — so neither player can learn anything before the other shot exists.

import { NextResponse } from "next/server";

import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
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
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;
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

    // ── Committed. Only now is anything published. ──────────────────────
    broadcastMatchUpdate(matchId, {
      phase: result.dto.phase,
      round: result.dto.round,
    });

    if (result.status === "waiting") {
      // The opponent learns a shot exists — never which cell it is.
      broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.ATTACK_LOCKED, {
        round: result.dto.round,
        seat: result.dto.you.seat,
      });
      broadcastBattleshipEvent(matchId, BATTLESHIP_EVENTS.OPPONENT_WAITING, {
        round: result.dto.round,
        waitingSeat: result.dto.you.seat,
      });
      return NextResponse.json({
        success: true,
        data: { ...result.dto, locked: true, resolved: null },
      });
    }

    const round = result.round;
    // If the deadline chose one of these attacks, say so — the SEATS and the
    // ROUND only, never a cell. The cell becomes public with the round result.
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
      errorType: "battleship_attack_error",
      errorMessage: error instanceof Error ? error.message : "Battleship attack failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/battleship/match/[matchId]/attack",
      game: "Battleship",
      metadata: { operation: "submit_attack" },
    });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
