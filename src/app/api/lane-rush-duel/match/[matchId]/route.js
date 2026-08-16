// src/app/api/lane-rush-duel/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles two auto-advance paths inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → advance to the first pick state.
//   2. `p1_turn` / `p2_turn` deadline elapsed → force-pick a random
//      tile for the current player (AFK nudge), then advance the
//      turn OR resolve the match.
//
// Visibility model:
//   • During active play the per-player towers (bad tile positions)
//     and the server seed are HIDDEN (null). Only the server seed
//     HASH is visible, so each player can verify fairness after the
//     match without seeing the layout early.
//   • The `actions` array is fully visible to both seats mid-match —
//     it only ever contains safe picks + holds (a bust is terminal),
//     which give away no bad-tile positions.
//   • Once `finished`: full reveal — both towers, the server seed,
//     and the full action history.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { fetchMatchWithAutoResolve } from "../../../../../lib/lane-rush-duel/serverStore";
import {
  RISK_PATHS,
  scoreFromActions,
} from "../../../../../lib/lane-rush-duel/constants";

function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const finished = match.status === "finished";
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const seat = viewerIsPlayer1 ? "player1" : "player2";
  const opponentSeat = viewerIsPlayer1 ? "player2" : "player1";

  const myLane = Number(seat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  const oppLane =
    Number(opponentSeat === "player1" ? match.p1Lane : match.p2Lane) || 0;
  const myHeld = Boolean(seat === "player1" ? match.p1Held : match.p2Held);
  const oppHeld = Boolean(
    opponentSeat === "player1" ? match.p1Held : match.p2Held,
  );
  const actions = Array.isArray(match.actions) ? match.actions : [];
  const myScore = scoreFromActions(actions, seat);
  const oppScore = scoreFromActions(actions, opponentSeat);

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    difficulty: match.difficulty,
    tilesPerLane: match.tilesPerLane,
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
    roundDeadline: match.roundDeadline,
    roundTimerSeconds: match.roundTimerSeconds,
    viewerIsPlayer1,
    isViewerTurn: match.currentTurnUserId === viewerUserId,
    myLane,
    myHeld,
    myScore,
    oppLane,
    oppHeld,
    oppScore,
    // Risk-path config so the client renders the path picker with
    // the exact same odds/points the server enforces.
    riskPaths: RISK_PATHS,
    // Action history — full reveal at finished; safe mid-match (only
    // safe picks + holds exist before resolution).
    actions,
    // Towers + server seed: hidden mid-match, revealed at finish.
    myTower: finished
      ? seat === "player1"
        ? match.p1Tower
        : match.p2Tower
      : null,
    oppTower: finished
      ? opponentSeat === "player1"
        ? match.p1Tower
        : match.p2Tower
      : null,
    p1Points: Number(match.p1Points) || 0,
    p2Points: Number(match.p2Points) || 0,
    serverSeed: finished ? match.serverSeed : null,
    serverSeedHash: match.serverSeedHash,
    p1ClientSeed: match.p1ClientSeed,
    p2ClientSeed: match.p2ClientSeed ?? null,
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

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatchForViewer(match, userId),
      },
    });
  } catch (error) {
    console.error("[lane-rush-duel/match] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
