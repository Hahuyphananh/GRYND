// src/app/api/slots-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles the auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → advance to spin_1 (3-second banner).
//   2. An active column's per-column deadline elapsed → auto-stop it
//      (grace / survival logic applies) and resolve when both runs end.
//
// CRITICAL — visibility model (anti-cheat):
//   • During a live spin round the viewer sees THEIR OWN sliding window
//     + run status, but the OPPONENT's inputs are scrubbed to run
//     STATUS ONLY (stoppedCount / survived / ended / …) via
//     `scrubMatchForViewer` — the opponent's columns stay hidden until
//     the round resolves.
//   • Once `finished` or `cancelled`: full reveal — the rounds array
//     carries both players' column streams + survival snapshots.
//     prizePaid / houseFee / result / winnerId are visible to both.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  enrichMatchesWithUsers,
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
  scrubMatchForViewer,
  isBotMatch,
} from "../../../../../lib/slots-pvp/serverStore.js";
import { viewerRunSnapshot } from "../../../../../lib/slots-pvp/engine.js";
import {
  MATCH_STATUS,
  pickPositiveInt,
  ROUND_TIMER_SECONDS,
} from "../../../../../lib/slots-pvp/constants.js";

// Per-viewer normaliser. Adds derived flags the match view needs to
// gate the STOP controls, render the correct seat identifier, and show
// the opponent's live run status (never their board).
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
  const now = Date.now();
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    theme: match.theme || "fruit",
    status: match.status,
    currentSpin: match.currentSpin ?? 1,
    // Scoreboard (single round): rounds won + total survived.
    roundsWonPlayer1: Number(match.roundsWonPlayer1) || 0,
    roundsWonPlayer2: Number(match.roundsWonPlayer2) || 0,
    p1Score: Number(match.p1Score) || 0,
    p2Score: Number(match.p2Score) || 0,
    // Viewer's own full inputs / opponent's scrubbed run status.
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
    // True when the viewer may still stop the active column this round
    // (spin status + their run not ended).
    viewerCanStop:
      isSpin &&
      Boolean(viewerIsParticipant) &&
      Boolean(viewerInputs) &&
      !Boolean(viewerInputs.ended),
    // Server-authoritative run snapshots: the viewer's OWN full run
    // (board + status + countdown) and the OPPONENT's scrubbed status.
    viewerRun: isSpin ? viewerRunSnapshot({ inputs: viewerInputs, now }) : null,
    opponentRun: isSpin ? viewerRunSnapshot({ inputs: opponentInputs, now }) : null,
    // True when the viewer is the creator AND the match is still
    // waiting for an opponent. Used to gate the "Cancel" button.
    viewerCanCancel:
      match.status === MATCH_STATUS.WAITING && viewerIsPlayer1,
    // True when this is a practice match against the developer's test
    // bot (free play — no tokens wagered). Used to label the match and
    // hide the Report button.
    isBot: Boolean(isBot),
  };
}

function normaliseRound(round) {
  return {
    id: round.id,
    spinNumber: round.spinNumber,
    player1Inputs: round.player1Inputs || {},
    player2Inputs: round.player2Inputs || {},
    // Full survival snapshots (column stream + grace/bust info) for
    // the reveal / history views.
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

    // Practice matches are identifiable by the test-account opponent.
    const isBot = await isBotMatch(scrubbed);

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
        match: normaliseMatch(scrubbed, userId, isBot),
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
