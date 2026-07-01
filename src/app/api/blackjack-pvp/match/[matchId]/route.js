// src/app/api/blackjack-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. If the
// round deadline has elapsed and any seat is still in `playing`,
// force-mark that seat `stood` so the round can resolve (this is the
// server's "AFK nudge").
//
// CRITICAL — visibility model:
//   • During active play (match.status in round_1/2/3), the
//     requester only sees their own real cards in
//     `match.player1Hand/player2Hand`. The opponent's active hand
//     is replaced with `{suit:"?", value:"?"}` stubs so the UI can
//     lay out the right number of card backs without leaking
//     values ("Opponent Playing…" placeholder).
//   • The `rounds` array only contains RESOLVED rounds (rows
//     persisted to `blackjack_pvp_rounds` after a round ends). For
//     those rows, BOTH hands + BOTH scores + BOTH states are
//     revealed simultaneously so the round-result screen can show
//     the disclosed hands + winner before the next round starts.
//   • When match.status flips to `finished` or `cancelled`, both
//     seats' hands have already been revealed by the in-play
//     match.status; the round rows remain the canonical reveal.
//
// Swap/Hold counters and the held-card payload follow the same
// seat-aware scrubbing: the viewer sees their OWN state in full, but
// the opponent's seat is collapsed to a boolean (counter is "used"
// or "not used") so their strategy cannot be inferred.
//
// Mirrors the auth/error/auth pattern of
// `src/app/api/roulette-pvp/match/[matchId]/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
} from "../../../../../lib/blackjack-pvp/serverStore";
import { MATCH_STATUS } from "../../../../../lib/blackjack-pvp/constants";

function isTerminalStatus(status) {
  return status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED;
}

function scrubHandInPlace(hand) {
  if (!Array.isArray(hand)) return [];
  return hand.map(() => ({ suit: "?", value: "?" }));
}

function scrubHeldCardInPlace(heldCard) {
  if (!heldCard) return null;
  return { suit: "?", value: "?" };
}

export async function GET(req, { params }) {
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
    const result = await fetchMatchWithAutoResolve(userId, matchId);
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }
    const match = result.match;
    if (!match) {
      return NextResponse.json(
        { success: false, error: "Match not found" },
        { status: 404 },
      );
    }

    const viewerIsPlayer1 = match.player1Id === userId;

    // Active match hands stay seat-scrubbed — the in-play view still
    // shows the "Opponent Playing…" placeholder. Reveal happens
    // exclusively in the resolved `rounds` history array (below).
    const player1HandForViewer = viewerIsPlayer1
      ? match.player1Hand
      : scrubHandInPlace(match.player1Hand);
    const player2HandForViewer = viewerIsPlayer1
      ? scrubHandInPlace(match.player2Hand)
      : match.player2Hand;

    // Winner-only prize disclosure so losers don't see the opponent's
    // payout amount in the response payload.
    const viewerIsWinner =
      match.winnerId !== null && match.winnerId === userId;

    // Fetch the resolved-rounds history. Every row here represents a
    // round that has ENDED, so both hands + scores + states on each
    // row are revealed simultaneously to BOTH seats. This is the
    // disclosure event the round-result modal renders against.
    const rounds = await fetchMatchRounds(matchId);

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
          // Active hand: VIEWER's real cards; opponent's hidden.
          player1Hand: player1HandForViewer,
          player2Hand: player2HandForViewer,
          player1State: match.player1State || "playing",
          player2State: match.player2State || "playing",
          viewerIsPlayer1,
          roundDeadline: match.roundDeadline,
          winnerId: match.winnerId,
          result: match.result,
          prizePaid:
            viewerIsWinner && match.prizePaid
              ? Number(match.prizePaid)
              : 0,
          houseFee:
            viewerIsWinner && match.houseFee ? Number(match.houseFee) : 0,
          roundTimer: match.roundTimerSeconds ?? 20,
          startedAt: match.startedAt,
          endedAt: match.endedAt,
          createdAt: match.createdAt,
          // Per-seat Swap/Hold counters. Only the VIEWER's seat is in
          // full; the opponent's seat is collapsed to a boolean so the
          // UI can't infer their strategy.
          player1SwapsUsed: viewerIsPlayer1
            ? match.player1SwapsUsed
            : match.player1SwapsUsed > 0
              ? 1
              : 0,
          player2SwapsUsed: !viewerIsPlayer1
            ? match.player2SwapsUsed
            : match.player2SwapsUsed > 0
              ? 1
              : 0,
          player1HoldsUsed: viewerIsPlayer1
            ? match.player1HoldsUsed
            : match.player1HoldsUsed > 0
              ? 1
              : 0,
          player2HoldsUsed: !viewerIsPlayer1
            ? match.player2HoldsUsed
            : match.player2HoldsUsed > 0
              ? 1
              : 0,
          player1HeldCard: viewerIsPlayer1
            ? match.player1HeldCard
            : scrubHeldCardInPlace(match.player1HeldCard),
          player2HeldCard: !viewerIsPlayer1
            ? match.player2HeldCard
            : scrubHeldCardInPlace(match.player2HeldCard),
          player1HeldResolved: viewerIsPlayer1
            ? match.player1HeldResolved
            : Boolean(match.player1HeldResolved),
          player2HeldResolved: !viewerIsPlayer1
            ? match.player2HeldResolved
            : Boolean(match.player2HeldResolved),
        },
        rounds: rounds.map((r) => ({
          id: r.id,
          roundNumber: r.roundNumber,
          // Round-end reveal: BOTH hands are fully visible to both
          // seats. The round-result screen drives a "fair" comparison
          // display since both players see the same card values.
          player1Hand: r.player1Hand || [],
          player2Hand: r.player2Hand || [],
          // Round-end reveal: BOTH scores are visible.
          player1Score: r.player1Score,
          player2Score: r.player2Score,
          // Round-end reveal: BOTH end-states are visible.
          player1State: r.player1State,
          player2State: r.player2State,
          roundWinner: r.roundWinner,
          viewerWonThisRound:
            (r.roundWinner === "player1" && viewerIsPlayer1) ||
            (r.roundWinner === "player2" && !viewerIsPlayer1),
          createdAt: r.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/match] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
