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
//   • Both players climb the SAME shared tower (bad tile per lane per
//     risk path). During active play the tower and the server seed
//     are HIDDEN (null) — only the server seed HASH is visible, so
//     each player can verify fairness after the match without seeing
//     the layout early.
//   • DEFERRED REVEAL: an action parks as `pending` until the
//     opponent answers the same row. Pending entries are scrubbed to
//     `{ action: "pending", seat, round }` — neither side learns the
//     other's current-row pick (not even its type) before acting.
//     `myPending` / `oppPending` tell the client who has locked in.
//   • Once `finished`: full reveal — the shared tower, the server
//     seed, and the full action history.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { fetchMatchWithAutoResolve } from "../../../../../lib/lane-rush-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../lib/lane-rush-duel/rooms";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  bankRateForSeat,
  bankedScoreOf,
  banksUsedBySeat,
  climbEnded,
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
  // Soft bank: locked totals, bank counts, live rates, and climb
  // status (busted/completed) for both seats.
  const myBanked = bankedScoreOf(match, seat);
  const oppBanked = bankedScoreOf(match, opponentSeat);
  const myBanks = banksUsedBySeat(match, seat);
  const oppBanks = banksUsedBySeat(match, opponentSeat);
  const myRate = bankRateForSeat(match, seat);
  const oppRate = bankRateForSeat(match, opponentSeat);
  const myEnded = climbEnded(match, seat);
  const oppEnded = climbEnded(match, opponentSeat);
  // Who has locked in an (unresolved) action for the current row.
  const myPending = actions.some(
    (a) => a && a.pending === true && a.seat === seat,
  );
  const oppPending = actions.some(
    (a) => a && a.pending === true && a.seat === opponentSeat,
  );

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
    myPending,
    oppPending,
    myLane,
    myHeld,
    myScore,
    myBanked,
    myBanks,
    myRate,
    myEnded,
    oppLane,
    oppHeld,
    oppScore,
    oppBanked,
    oppBanks,
    oppRate,
    oppEnded,
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
    // The opponent's tower is never part of the viewer payload. In
    // simultaneous play it has no interactive purpose and must not
    // expose hidden board state.
    oppTower: null,
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

function identityFields(identity) {
  return {
    player1Name: identity.player1?.name ?? null,
    player1IconKey: identity.player1?.iconKey ?? null,
    player1NameColor: identity.player1?.nameColor ?? null,
    player1ProfileFrame: identity.player1?.profileFrame ?? null,
    player2Name: identity.player2?.name ?? null,
    player2IconKey: identity.player2?.iconKey ?? null,
    player2NameColor: identity.player2?.nameColor ?? null,
    player2ProfileFrame: identity.player2?.profileFrame ?? null,
  };
}

export async function GET(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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

    // Real seat identity (username + official icon + equipped name
    // color) for both seats. One query for both; the bot seat
    // ("AI_BOT") stays null and the client falls back to its
    // localized "GRYND AI" label.
    const identity = await getSeatIdentity(
      match.player1Id,
      match.player2Id,
    );

    // The `ready` window only ends because a status request arrived (there
    // is no background scheduler), so the player whose request started the
    // match would otherwise be placing tiles while the other client was
    // still on the "get ready" banner, waiting for its own poll. Push the
    // transition to the per-match room so both seats start together (fire
    // and forget; a missed push falls back to the poll).
    if (result.advanced) {
      broadcastMatchUpdate(matchId, {
        status: match.status,
        currentTurnUserId: match.currentTurnUserId ?? null,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        match: {
          ...normaliseMatchForViewer(match, userId),
          ...identityFields(identity),
        },
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
