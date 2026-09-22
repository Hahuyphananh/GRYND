// src/app/api/lane-rush-duel/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles these auto-advance paths inside
// `fetchMatchWithAutoResolve` (all on the SERVER clock):
//   1. a playable match with no turn owner → seed the opening turn.
//   2. `ready` deadline elapsed → advance to the active state.
//   3. the current player's 15s choice window elapsed → end that
//      attempt (back to Row 1) and hand the turn to the opponent.
//
// Visibility model:
//   • Both players cross the SAME shared bridge (10 rows, exactly one
//     bad tile per row). During play the layout's hidden bad tiles are
//     NOT sent: `bridge` is the client view only (geometry + the tiles
//     that are already broken + the commitment hash), so each player
//     can verify fairness after the match without seeing the solution
//     early. `myRow` / `oppRow` are each seat's progress and
//     `myFlags` / `oppFlags` are the public memory flags (2 each).
//   • Turn ownership is server-side: `currentTurnUserId` + `isViewerTurn`
//     tell the client whose 15s choice window is live (`roundDeadline`).
//   • Once `finished`: full reveal — the bridge layout, the server
//     seed, and the full action history.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import { fetchMatchWithAutoResolve } from "../../../../../lib/lane-rush-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../lib/lane-rush-duel/rooms";
import { getSeatIdentity } from "../../../../../lib/seatIdentity";
import {
  BRIDGE_FLAGS_PER_PLAYER,
  BRIDGE_ROWS,
  BRIDGE_TILE_CHOICE_SECONDS,
  brokenTilesOf,
  flagsLeftForSeat,
  flagsOf,
  seatRow,
} from "../../../../../lib/lane-rush-duel/constants";

function normaliseMatchForViewer(match, viewerUserId) {
  if (!match) return null;
  const finished = match.status === "finished";
  const viewerIsPlayer1 = match.player1Id === viewerUserId;
  const seat = viewerIsPlayer1 ? "player1" : "player2";
  const opponentSeat = viewerIsPlayer1 ? "player2" : "player1";

  const actions = Array.isArray(match.actions) ? match.actions : [];

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    difficulty: match.difficulty,
    status: match.status,
    firstPlayerId: match.firstPlayerId,
    currentTurnUserId: match.currentTurnUserId,
    // TIMER: the deadline is absolute server time, and `serverNow` is the
    // server's own clock at the moment of this response. A client measures its
    // remaining time as `roundDeadline - serverNow` (never against its own
    // clock), so a reconnect — or a device with a skewed clock — still shows
    // the correct remaining time. The countdown is DISPLAY ONLY: the timeout
    // is resolved server-side against `roundDeadline` (see timeoutAttempt), so
    // a client clock can never decide a result.
    roundDeadline: match.roundDeadline,
    serverNow: new Date().toISOString(),
    roundTimerSeconds: match.roundTimerSeconds ?? BRIDGE_TILE_CHOICE_SECONDS,
    viewerIsPlayer1,
    isViewerTurn: match.currentTurnUserId === viewerUserId,
    // ── Shared bridge (the redesigned game) ───────────────────────────
    // `bridge` is already scrubbed by the store: geometry + broken tiles +
    // commitment mid-match (never the layout), full reveal at finish. Both
    // seats read the SAME layout, and the rows below are each seat's
    // progress on it — a fall resets a row to 0, crossing BRIDGE_ROWS wins.
    bridge: match.bridge ?? null,
    bridgeRows: BRIDGE_ROWS,
    tileCount: Number(match.bridge?.tiles) || null,
    myRow: seatRow(match, seat),
    oppRow: seatRow(match, opponentSeat),
    broken: brokenTilesOf(match),
    myFlags: flagsOf(match, seat),
    oppFlags: flagsOf(match, opponentSeat),
    myFlagsLeft: flagsLeftForSeat(match, seat),
    oppFlagsLeft: flagsLeftForSeat(match, opponentSeat),
    flagsPerPlayer: BRIDGE_FLAGS_PER_PLAYER,
    // Action history — every jump/timeout/flag in order, for both seats.
    actions,
    // The SERVER SEED is hidden mid-match and revealed at finish, so both
    // players can re-derive the shared bridge and verify it was fair.
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
