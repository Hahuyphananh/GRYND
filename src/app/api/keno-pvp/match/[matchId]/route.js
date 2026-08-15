// src/app/api/keno-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles the auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → open round 1 (generate the shared
//      draw + release schedule).
//   2. A live round's deadline elapsed → score both players' catches,
//      stamp the round winner, and open the next round (or settle).
//
// CRITICAL — visibility model (anti-cheat):
//   • During a live round the viewer sees THEIR OWN caught balls +
//     the shared draw (identical for both players), but the
//     OPPONENT's catches are scrubbed to a count-only signal via
//     `scrubMatchForViewer` — their ticket stays hidden until the
//     round resolves.
//   • Once `finished` or `cancelled`: full reveal — the rounds array
//     carries both players' catches + scores. prizePaid / houseFee /
//     result / winnerId are visible to both.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  enrichMatchesWithUsers,
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
  scrubMatchForViewer,
  isBotMatch,
} from "../../../../../lib/keno-pvp/serverStore";
import {
  MATCH_STATUS,
  pickPositiveInt,
  ROUND_TIMER_SECONDS,
} from "../../../../../lib/keno-pvp/constants";

// Per-viewer normaliser. Adds derived flags the match view needs to
// gate the catch controls, render the correct seat identifier, and
// show the opponent's live catch count (never their ticket).
function normaliseMatch(match, viewerUserId, isBot = false) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const viewerIsPlayer2 = match.player2Id === viewerUserId;
  const viewerIsParticipant = viewerIsPlayer1 || viewerIsPlayer2;
  const viewerSeat = viewerIsPlayer1
    ? "player1"
    : viewerIsPlayer2
      ? "player2"
      : null;
  const viewerCatches = viewerIsPlayer1
    ? match.p1Catches
    : viewerIsPlayer2
      ? match.p2Catches
      : null;
  const opponentCatches = viewerIsPlayer1
    ? match.p2Catches
    : viewerIsPlayer2
      ? match.p1Catches
      : null;
  const isRound = /^round_\d+$/.test(match.status || "");
  const now = Date.now();
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentRound: match.currentRound ?? 1,
    // Scoreboard: round wins + cumulative points.
    roundsWonPlayer1: Number(match.roundsWonPlayer1) || 0,
    roundsWonPlayer2: Number(match.roundsWonPlayer2) || 0,
    p1Score: Number(match.p1Score) || 0,
    p2Score: Number(match.p2Score) || 0,
    // The shared draw (identical for both players) + the release
    // schedule the client animates from.
    currentDraw: Array.isArray(match.currentDraw) ? match.currentDraw : [],
    roundDeadline: match.roundDeadline,
    roundTimer: pickPositiveInt(match.roundTimerSeconds, ROUND_TIMER_SECONDS),
    // Viewer's own caught balls / opponent's live catch count.
    myCatches: Array.isArray(viewerCatches) ? viewerCatches : [],
    opponentCatchCount: Array.isArray(opponentCatches)
      ? opponentCatches.length
      : 0,
    winnerId: match.winnerId ?? null,
    result: match.result ?? null,
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    players: match.players ?? null,
    // Viewer-aware flags.
    viewerUserId,
    viewerIsParticipant,
    viewerSeat,
    viewerIsPlayer1,
    // True when the viewer may catch balls this round. The server
    // re-validates the deadline + ball window on every catch.
    viewerCanCatch: isRound && Boolean(viewerIsParticipant),
    // True when the viewer is the creator AND the match is still
    // waiting for an opponent. Used to gate the "Cancel" button.
    viewerCanCancel:
      match.status === MATCH_STATUS.WAITING && viewerIsPlayer1,
    // True when this is a practice match against the developer's test
    // bot (free play — no tokens wagered).
    isBot: Boolean(isBot),
  };
}

function normaliseRound(round) {
  return {
    id: round.id,
    roundNumber: round.roundNumber,
    sharedDraw: Array.isArray(round.sharedDraw) ? round.sharedDraw : [],
    player1Catches: Array.isArray(round.player1Catches)
      ? round.player1Catches
      : [],
    player2Catches: Array.isArray(round.player2Catches)
      ? round.player2Catches
      : [],
    player1Score: round.player1Score ?? 0,
    player2Score: round.player2Score ?? 0,
    roundWinner: round.roundWinner ?? null,
    createdAt: round.createdAt,
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

  // Next.js 15+/16: API route `params` is a Promise — must await.
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

    // Enrich with user names + profile images so the match view can
    // render proper player heads. Best-effort — never crash the route
    // on lookup failure.
    let enrichedMatch = match;
    try {
      const e = await enrichMatchesWithUsers(match);
      if (e) enrichedMatch = e;
    } catch (err) {
      console.warn(
        "[keno-pvp/match] user enrichment failed:",
        err && err.message ? err.message : err,
      );
      enrichedMatch = match;
    }

    // Anti-cheat scrub: hide the OPPONENT's catches while the round
    // is live (the viewer's own ticket stays visible).
    const scrubbed = scrubMatchForViewer(enrichedMatch, userId);

    const isBot = await isBotMatch(scrubbed);

    // Fetch the round history (reveal screen + rounds strip).
    let rounds = [];
    try {
      rounds = await fetchMatchRounds(matchId);
    } catch (err) {
      console.warn(
        "[keno-pvp/match] fetchMatchRounds failed:",
        err && err.message ? err.message : err,
      );
      rounds = [];
    }

    return NextResponse.json({
      success: true,
      data: {
        // Server clock so the client can sync its glow stream to the
        // authoritative grading clock — devices whose clock drifts
        // otherwise see tiles light up at the wrong moment.
        serverTime: Date.now(),
        match: normaliseMatch(scrubbed, userId, isBot),
        rounds: rounds.map(normaliseRound),
      },
    });
  } catch (error) {
    console.error(
      "[keno-pvp/match] error:",
      error && error.stack ? error.stack : error,
    );
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
