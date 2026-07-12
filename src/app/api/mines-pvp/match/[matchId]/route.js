// src/app/api/mines-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles three auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → advance to first pick state
//      (p1_turn or p2_turn depending on the host's first-player
//      roll).
//   2. `p1_turn` / `p2_turn` deadline elapsed → force-pick a random
//      cell for the current player (AFK nudge), then advance the
//      turn OR resolve the match (if it was player2's auto-pick).
//
// CRITICAL — visibility model:
//   • During active play (`ready` / `p1_turn` / `p2_turn`):
//     - the `board` jsonb is HIDDEN (replaced with `null`) so the
//       client can't peek at mine positions mid-match.
//     - the VIEWER sees their OWN pick in full (cellIndex +
//       pickIsMine + pickedAt + autoPicked).
//     - the OPPONENT'S pick is partially hidden: the cellIndex is
//       returned (so the UI can render "opponent took this cell")
//       but `pickIsMine` is `null` until the match finishes — the
//       viewer can't infer whether the opponent survived their
//       pick.
//   • Once `finished`: full reveal — both picks, both pick results,
//     board, result, prizePaid, houseFee all visible to BOTH seats.
//     (The viewer-only prize disclosure is also lifted — both
//     players see the totals so the result screen is symmetric.)
//
// Mirrors the auth/error/visibility pattern of
// `src/app/api/blackjack-pvp/match/[matchId]/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
} from "../../../../../lib/mines-pvp/serverStore";
import { MATCH_STATUS } from "../../../../../lib/mines-pvp/constants";

function isTerminalStatus(status) {
  return status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED;
}

// Per-seat scrub helper. Mid-match, the OPPOSITE seat's pick result
// is hidden from the viewer; the cellIndex itself stays so the
// board UI can render "opponent took this cell" without
// disambiguating mine vs safe.
function scrubPickForViewer(match, viewerUserId) {
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const finished = isTerminalStatus(match.status);

  return {
    // Player 1's pick: fully visible to p1 viewer, partially
    // visible (cellIndex only) to p2 viewer.
    p1Pick: match.p1Pick ?? null,
    p1PickIsMine:
      finished || viewerIsPlayer1 ? match.p1PickIsMine ?? null : null,
    p1PickedAt:
      finished || viewerIsPlayer1 ? match.p1PickedAt ?? null : null,
    p1AutoPicked:
      finished || viewerIsPlayer1 ? Boolean(match.p1AutoPicked) : false,

    // Player 2's pick: mirror logic.
    p2Pick: match.p2Pick ?? null,
    p2PickIsMine:
      finished || !viewerIsPlayer1 ? match.p2PickIsMine ?? null : null,
    p2PickedAt:
      finished || !viewerIsPlayer1 ? match.p2PickedAt ?? null : null,
    p2AutoPicked:
      finished || !viewerIsPlayer1 ? Boolean(match.p2AutoPicked) : false,
  };
}

function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const finished = isTerminalStatus(match.status);

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    minesCount: match.minesCount,
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
    viewerIsPlayer1,
    isViewerTurn: match.currentTurnUserId === viewerUserId,
    ...scrubPickForViewer(match, viewerUserId),
    // Board: full reveal at finished, hidden mid-match.
    board: finished ? match.board : null,
    // Result + payout. Loser sees zero prize/fees (avoids leaking
    // the winner's exact payout amount). Draws are symmetric
    // (both see prizePaid=0, houseFee=0, result='draw').
    result: match.result ?? null,
    winnerId: match.winnerId ?? null,
    prizePaid:
      finished && match.winnerId === viewerUserId
        ? Number(match.prizePaid) || 0
        : 0,
    houseFee:
      finished && match.winnerId === viewerUserId
        ? Number(match.houseFee) || 0
        : 0,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
  };
}

export async function GET(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Next.js 15+/16: API route `params` is a Promise — must await before
  // reading properties. Accessing it synchronously yields `undefined`,
  // which `Number(undefined)` coerces to `NaN`, which the finite-check
  // below rejects with "Invalid matchId" — masking the real match and
  // stranding the user on the "Invalid match link." panel right after
  // they create a lobby. Same fix applied to the roulette-pvp and
  // blackjack-pvp match routes.
  const resolvedParams = (await params) || {};
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

    // Always returns 1 row (this is a single-round game) — kept as
    // an array for API symmetry with the multi-round PvP systems.
    const rounds = await fetchMatchRounds(matchId);

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForViewer(match, userId),
        rounds: rounds.map((r) => ({
          id: r.id,
          roundNumber: r.roundNumber,
          p1Pick: r.p1Pick,
          p2Pick: r.p2Pick,
          p1PickIsMine: r.p1PickIsMine,
          p2PickIsMine: r.p2PickIsMine,
          p1AutoPicked: Boolean(r.p1AutoPicked),
          p2AutoPicked: Boolean(r.p2AutoPicked),
          boardSnapshot: r.boardSnapshot ?? null,
          roundWinner: r.roundWinner,
          createdAt: r.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
