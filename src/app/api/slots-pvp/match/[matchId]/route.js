// src/app/api/slots-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles two auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → advance to spin_1 (3-second banner).
//   2. Spin-round deadline elapsed + a board not locked → auto-stop
//      the remaining reels and resolve the round (never > 10s).
//
// CRITICAL — visibility model (anti-cheat):
//   • During a live spin round the viewer sees THEIR OWN full inputs
//     (their 3x3 reels + stop progress) but the OPPONENT's inputs are
//     scrubbed to `{ reelsStopped, autoStopped, boardLocked }` via
//     `scrubMatchForViewer` — the opponent's final reels stay hidden
//     until the round resolves.
//   • Once `finished` or `cancelled`: full reveal — the rounds array
//     carries both players' final reels + full scoring snapshots.
//     prizePaid / houseFee / result / winnerId are visible to both.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  enrichMatchesWithUsers,
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
  scrubMatchForViewer,
} from "../../../../../lib/slots-pvp/serverStore.js";
import { viewerRoundScoreSnapshot } from "../../../../../lib/slots-pvp/engine.js";
import {
  MATCH_STATUS,
  pickPositiveInt,
  ROUND_TIMER_SECONDS,
} from "../../../../../lib/slots-pvp/constants.js";
import { getTheme } from "../../../../../lib/slotThemes.jsx";

// Per-viewer normaliser. Adds derived flags the match view needs to
// gate the reel STOP buttons, render the correct seat identifier,
// and show the opponent's live lock progress.
function normaliseMatch(match, viewerUserId) {
  if (!match) return null;
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const viewerIsPlayer2 = match.player2Id === viewerUserId;
  const viewerIsParticipant = viewerIsPlayer1 || viewerIsPlayer2;
  const viewerSeat = viewerIsPlayer1
    ? "player1"
    : viewerIsPlayer2
      ? "player2"
      : null;
  // Spectator-safe: a non-participant never receives either seat's
  // inputs as their own (default both to null).
  const viewerInputs = viewerIsPlayer1
    ? match.p1CurrentInputs
    : viewerIsPlayer2
      ? match.p2CurrentInputs
      : null;
  const opponentInputs = viewerIsPlayer1
    ? match.p2CurrentInputs
    : viewerIsPlayer2
      ? match.p1CurrentInputs
      : null;
  const isSpin = /^spin_\d+$/.test(match.status || "");
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    theme: match.theme || "fruit",
    status: match.status,
    currentSpin: match.currentSpin ?? 1,
    // Best-of-5 scoreboard: rounds won by each player + aggregate
    // points (used as the rounds-won tie-break).
    roundsWonPlayer1: Number(match.roundsWonPlayer1) || 0,
    roundsWonPlayer2: Number(match.roundsWonPlayer2) || 0,
    p1Score: Number(match.p1Score) || 0,
    p2Score: Number(match.p2Score) || 0,
    // Viewer's own full inputs / opponent's scrubbed progress.
    p1CurrentInputs: match.p1CurrentInputs || null,
    p2CurrentInputs: match.p2CurrentInputs || null,
    roundDeadline: match.roundDeadline,
    roundTimer: pickPositiveInt(match.roundTimerSeconds, ROUND_TIMER_SECONDS),
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
    // True when the viewer may still stop a reel this round (spin
    // status + board not locked). The STOP buttons are enabled iff
    // this is true.
    viewerCanStop:
      isSpin && Boolean(viewerIsParticipant) && !Boolean(viewerInputs?.boardLocked),
    // True when the viewer's board is locked (all 3 reels stopped).
    viewerHasLocked: Boolean(viewerInputs?.boardLocked),
    // True when the OPPONENT's board is locked (round can resolve).
    opponentHasLocked: Boolean(opponentInputs?.boardLocked),
    // True when the viewer is the creator AND the match is still
    // waiting for an opponent. Used to gate the "Cancel" button.
    viewerCanCancel:
      match.status === MATCH_STATUS.WAITING && viewerIsPlayer1,
    // Server-authoritative CURRENT round score for the VIEWER's own
    // board (full once it locks, live stop-bonus total before then).
    // Recomputed on every poll from the viewer's own inputs via the
    // pure engine — the opponent's score is never revealed here.
    viewerRoundScore: isSpin
      ? viewerRoundScoreSnapshot({
          inputs: viewerInputs,
          symbols: getTheme(match.theme || "fruit").symbols,
        })
      : null,
  };
}

function normaliseRound(round) {
  return {
    id: round.id,
    spinNumber: round.spinNumber,
    player1Inputs: round.player1Inputs || {},
    player2Inputs: round.player2Inputs || {},
    // Full scoring snapshots (reels + 8-line breakdown + stop
    // accuracy + total score) for the reveal / history views.
    player1Result: round.player1Result || null,
    player2Result: round.player2Result || null,
    player1AutoSpun: Boolean(round.player1AutoSpun),
    player2AutoSpun: Boolean(round.player2AutoSpun),
    spinPointsPlayer1: round.spinPointsPlayer1 ?? 0,
    spinPointsPlayer2: round.spinPointsPlayer2 ?? 0,
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
        "[slots-pvp/match] user enrichment failed:",
        err && err.message ? err.message : err,
      );
      enrichedMatch = match;
    }

    // Anti-cheat scrub: hide the OPPONENT's final reels + score while
    // a spin round is live (the viewer's own reels stay visible).
    const scrubbed = scrubMatchForViewer(enrichedMatch, userId);

    // Fetch the round history (reveal screen + rounds strip).
    let rounds = [];
    try {
      rounds = await fetchMatchRounds(matchId);
    } catch (err) {
      console.warn(
        "[slots-pvp/match] fetchMatchRounds failed:",
        err && err.message ? err.message : err,
      );
      rounds = [];
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(scrubbed, userId),
        rounds: rounds.map(normaliseRound),
      },
    });
  } catch (error) {
    console.error(
      "[slots-pvp/match] error:",
      error && error.stack ? error.stack : error,
    );
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
