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
  viewerPlayerState,
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

// BUG-FIX (async params on Next.js 16): the [matchId] segment's
// `params` is a Promise — reading `params?.matchId` synchronously
// returns `undefined` and `Number(undefined) === NaN`, which made
// every polling fetch hit the 400 "Invalid matchId" branch, silently
// dropping the response on the client (silent mode) and leaving both
// players stuck on the "Chargement…" loading screen with the match
// never auto-advancing from `ready` to `round_1`. Awaiting `params`
// matches the page-side fix from the `fix(pvp-match-views)` commit
// that already covers the dynamic-route page handlers.
export async function GET(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const resolvedParams = await params;
  const matchId = Number(resolvedParams?.matchId);
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
          roundNumber: match.roundNumber,
          roundsWonPlayer1: match.roundsWonPlayer1,
          roundsWonPlayer2: match.roundsWonPlayer2,
          // Active hand: VIEWER's real cards; opponent's hidden.
          player1Hand: player1HandForViewer,
          player2Hand: player2HandForViewer,
          // Per Prompt 7: opponent's seat state is hidden during
          // active play so they can't infer whether we've stood
          // (or busted) before the round-end reveal.
          player1State: viewerPlayerState(match, 1, userId),
          player2State: viewerPlayerState(match, 2, userId),
          viewerIsPlayer1,
          roundDeadline: match.roundDeadline,
          winner: match.winner,
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
          player1UsedSwap: viewerIsPlayer1
            ? match.player1UsedSwap
            : match.player1UsedSwap > 0
              ? 1
              : 0,
          player2UsedSwap: !viewerIsPlayer1
            ? match.player2UsedSwap
            : match.player2UsedSwap > 0
              ? 1
              : 0,
          player1UsedFreeze: viewerIsPlayer1
            ? match.player1UsedFreeze
            : match.player1UsedFreeze > 0
              ? 1
              : 0,
          player2UsedFreeze: !viewerIsPlayer1
            ? match.player2UsedFreeze
            : match.player2UsedFreeze > 0
              ? 1
              : 0,
          player1FrozenCard: viewerIsPlayer1
            ? match.player1FrozenCard
            : scrubHeldCardInPlace(match.player1FrozenCard),
          player2FrozenCard: !viewerIsPlayer1
            ? match.player2FrozenCard
            : scrubHeldCardInPlace(match.player2FrozenCard),
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
