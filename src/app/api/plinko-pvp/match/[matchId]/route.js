// src/app/api/plinko-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles two auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → advance to ball_1 (3-second
//      banner).
//   2. Per-ball deadline elapsed + at least one seat uncommitted →
//      auto-launch the missing seat(s) via autoLaunchInputs, then
//      resolve the ball.
//
// CRITICAL — visibility model:
//   • During active play (ball_1 / ball_2 / ball_3):
//     - p1CurrentInputs / p2CurrentInputs are visible to BOTH
//       seats (the slider inputs aren't secret; they're what the
//       player committed before launch).
//     - The rounds history (player1Result / player2Result with the
//       full path) is only populated AFTER the ball resolves, so
//       there's no mid-ball information leak.
//   • Once `finished` or `cancelled`: full reveal — all 3 balls'
//       inputs + simulation results are returned via the rounds
//       array. prizePaid / houseFee / result / winnerId are
//       visible to both seats.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  enrichMatchesWithUsers,
  fetchMatchWithAutoResolve,
  fetchMatchRounds,
} from "../../../../../lib/plinko-pvp/serverStore";
import {
  LAUNCHABLE_STATES,
  MATCH_STATUS,
} from "../../../../../lib/plinko-pvp/constants";

function isTerminalStatus(status) {
  return (
    status === MATCH_STATUS.FINISHED || status === MATCH_STATUS.CANCELLED
  );
}

// Per-viewer normaliser. Adds derived flags the match view (task 9)
// needs to gate the commit panel, render the correct seat
// identifier, and show the "opponent launched" hint. Mirrors the
// `normaliseMatchForViewer(match, viewerUserId)` pattern from
// `src/app/api/mines-pvp/match/[matchId]/route.js`.
//
// The caller IS expected to be a participant (fetchMatchWithAutoResolve
// already 403s non-participants). We still set `viewerIsParticipant`
// defensively so the frontend can render a "spectator" placeholder
// if the API contract ever loosens.
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
  const viewerInputs = viewerIsPlayer1
    ? match.p1CurrentInputs
    : match.p2CurrentInputs;
  const opponentInputs = viewerIsPlayer1
    ? match.p2CurrentInputs
    : match.p1CurrentInputs;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentBall: match.currentBall ?? 1,
    // Cumulative TOTAL points for each player across the 3 balls.
    // The match view surfaces this at the top of each player's
    // name in the side panels so the running sum is always visible.
    p1Score: match.p1Score ?? 0,
    p2Score: match.p2Score ?? 0,
    // Per-ball "ball in flight" indicators. Null after the ball
    // resolves (the rounds row holds the canonical record).
    p1CurrentInputs: match.p1CurrentInputs || null,
    p2CurrentInputs: match.p2CurrentInputs || null,
    // Per-seat "Ready" booleans. Both must be true for resolve.
    p1Ready: Boolean(match.p1Ready),
    p2Ready: Boolean(match.p2Ready),
    roundDeadline: match.roundDeadline,
    roundTimer: match.roundTimerSeconds ?? 20,
    winnerId: match.winnerId ?? null,
    result: match.result ?? null,
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    // Player heads (displayName + profileImageUrl). Populated by
    // enrichMatchesWithUsers. The match view uses these to render
    // real names instead of truncation. p1 == player1Id seat, p2 ==
    // player2Id seat — so the viewer (viewerSeat) can map directly.
    players: match.players ?? null,
    // Viewer-aware flags. The match view (task 9) uses these to
    // gate the commit panel + render the seat-specific score.
    viewerUserId,
    viewerIsParticipant,
    viewerSeat,
    viewerIsPlayer1,
    // True when the match is in a launchable state AND the viewer
    // hasn't already committed/ready for the current ball. The
    // commit panel's "Ready" button is enabled iff this is true.
    viewerCanLaunch:
      LAUNCHABLE_STATES.has(match.status) &&
      Boolean(viewerIsParticipant) &&
      !viewerInputs,
    // True when the viewer has already committed for the current
    // ball (the panel shows the "Launched" lock-in hint).
    viewerHasCommitted: Boolean(viewerInputs),
    // True when the OPPONENT has already committed for the current
    // ball (the panel shows the "Opponent launched" hint while the
    // viewer is still composing their own inputs).
    opponentHasCommitted: Boolean(opponentInputs),
    // True when the viewer is the creator AND the match is still
    // waiting for an opponent. Used to gate the "Cancel" button.
    viewerCanCancel:
      match.status === MATCH_STATUS.WAITING &&
      viewerIsPlayer1,
  };
}

function normaliseRound(round) {
  return {
    id: round.id,
    ballNumber: round.ballNumber,
    player1Inputs: round.player1Inputs || {},
    player2Inputs: round.player2Inputs || {},
    // Full simulation result (including path) for the ball animation.
    player1Result: round.player1Result || null,
    player2Result: round.player2Result || null,
    player1AutoLaunched: Boolean(round.player1AutoLaunched),
    player2AutoLaunched: Boolean(round.player2AutoLaunched),
    ballPointsPlayer1: round.ballPointsPlayer1 ?? 0,
    ballPointsPlayer2: round.ballPointsPlayer2 ?? 0,
    ballOutcome: round.ballOutcome ?? null,
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

  // Next.js 15+/16: API route `params` is a Promise — must await
  // before reading properties.
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
    // on lookup failure (degrades to the player-N labels). The bug-fix
    // here is critical: previously, the API only returned
    // clerkIds, so the UI displayed "user_xxxx…" truncation. Now the
    // client gets {displayName, profileImageUrl}.
    let enrichedMatch = match;
    try {
      const e = await enrichMatchesWithUsers(match);
      if (e) enrichedMatch = e;
    } catch (err) {
      console.warn(
        "[plinko-pvp/match] user enrichment failed:",
        err && err.message ? err.message : err,
      );
      enrichedMatch = match;
    }

    // Fetch the round history. The client uses this to render the
    // ball animation for each ball after it resolves (and for the
    // final reveal screen). At most REQUIRED_BALLS rows.
    let rounds = [];
    try {
      rounds = await fetchMatchRounds(matchId);
    } catch (err) {
      // Rounds fetch failure shouldn't fail the whole route. The
      // match itself is the primary payload; round history is
      // adornment for the reveal screen. Log + carry on.
      console.warn(
        "[plinko-pvp/match] fetchMatchRounds failed:",
        err && err.message ? err.message : err,
      );
      rounds = [];
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(enrichedMatch, userId),
        rounds: rounds.map(normaliseRound),
      },
    });
  } catch (error) {
    // Capture both stack and message so 500s are debuggable from the
    // server logs without needing to reproduce. This addresses the
    // "500 errors after first round" report — even if the underlying
    // bug is upstream (a Postgres advisory-lock collision, a Drizzle
    // jsonb serialization edge case, etc.), wrapping every API route
    // in a try/catch + stack log means we never silently 500.
    console.error(
      "[plinko-pvp/match] error:",
      error && error.stack ? error.stack : error,
    );
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
