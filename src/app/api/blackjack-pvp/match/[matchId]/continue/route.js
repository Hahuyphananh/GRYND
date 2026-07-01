// src/app/api/blackjack-pvp/match/[matchId]/continue/route.js
//
// POST — force-advance the Best-of-3 transition screen from
// MATCH_STATUS.BETWEEN_ROUNDS straight into the next round.
//
// Called by the match page's BetweenRoundsScreen "Continue now"
// button; auto-advance kicks in after `BETWEEN_ROUNDS_MS` even if the
// player never taps the button. Both paths funnel through
// `continueMatch` in serverStore which:
//   • Validates the participant + BETWEEN_ROUNDS status
//   • Uses a row-level FOR UPDATE lock to serialise against the
//     auto-advance helper that runs from /status polls
//   • Conditional UPDATE on `status='between_rounds'` so two
//     concurrent calls don't double-deal

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { continueMatch } from "../../../../../../lib/blackjack-pvp/serverStore";
import { MATCH_STATUS } from "../../../../../../lib/blackjack-pvp/constants";

function isTerminalStatus(status) {
  return status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED;
}

// Minimal scrub helper for this route — only the active round's hand
// fields are emitted (rounds history isn't returned).
function scrubHandInPlace(hand) {
  if (!Array.isArray(hand)) return [];
  return hand.map(() => ({ suit: "?", value: "?" }));
}

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const matchId = Number(params?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await continueMatch({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 409 },
      );
    }

    const match = result.match;
    const viewerIsPlayer1 = match.player1Id === userId;

    // Re-scrub to be safe — if the advance succeeded but for any
    // reason returned a row without a fresh deck, this keeps
    // opponent's hand hidden.
    const player1HandForViewer = viewerIsPlayer1
      ? match.player1Hand
      : scrubHandInPlace(match.player1Hand);
    const player2HandForViewer = viewerIsPlayer1
      ? scrubHandInPlace(match.player2Hand)
      : match.player2Hand;

    return NextResponse.json({
      success: true,
      data: {
        match: {
          id: match.id,
          player1Id: match.player1Id,
          player2Id: match.player2Id,
          stakeAmount: Number(match.stakeAmount),
          status: match.status,
          currentRound: match.currentRound,
          scorePlayer1: match.scorePlayer1,
          scorePlayer2: match.scorePlayer2,
          player1Hand: player1HandForViewer,
          player2Hand: player2HandForViewer,
          player1State: match.player1State || "playing",
          player2State: match.player2State || "playing",
          viewerIsPlayer1,
          roundDeadline: match.roundDeadline,
          roundTimer: match.roundTimerSeconds ?? 20,
        },
        advanced: true,
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/match/continue] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
