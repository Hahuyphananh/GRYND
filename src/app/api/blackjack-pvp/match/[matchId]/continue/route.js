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
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import {
  continueMatch,
  playAiTurn,
  viewerPlayerState,
} from "../../../../../../lib/blackjack-pvp/serverStore";
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

// BUG-FIX (async params on Next.js 16): await `params` so the
// BetweenRoundsScreen "Continue now" button actually reaches
// `continueMatch` server-side. Synchronous access turned matchId
// into NaN and short-circuited this endpoint to a 400.
export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  const resolvedParams = await params;
  const matchId = Number(resolvedParams?.matchId);
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

    let match = result.match;
    if (match.isAi && match.player1Id === userId) {
      try {
        const aiResult = await playAiTurn({ userId, matchId });
        if (!aiResult.error && aiResult.match) match = aiResult.match;
      } catch (error) {
        console.error("[blackjack-pvp/continue] AI turn failed:", error);
      }
    }
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
          isAi: Boolean(match.isAi),
          stakeAmount: Number(match.stakeAmount),
          status: match.status,
          roundNumber: match.roundNumber,
          roundsWonPlayer1: match.roundsWonPlayer1,
          roundsWonPlayer2: match.roundsWonPlayer2,
          player1Hand: player1HandForViewer,
          player2Hand: player2HandForViewer,
          // Wire-only computed booleans (Prompt 9 schema refactor).
          player1Standing:
            viewerPlayerState(match, 1, userId) !== "playing",
          player2Standing:
            viewerPlayerState(match, 2, userId) !== "playing",
          // Between-rounds has resolved so opponent state is no
          // longer secret — but route through viewerPlayerState for
          // type-consistency with the other match reads.
          player1State: viewerPlayerState(match, 1, userId),
          player2State: viewerPlayerState(match, 2, userId),
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
