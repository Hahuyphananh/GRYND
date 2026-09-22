// src/app/api/keno-pvp/match/[matchId]/route.js
//
// GET — fetch current match state with auto-resolve behaviour. The
// server store handles every auto-advance path inside
// `fetchMatchWithAutoResolve`:
//   1. `ready` deadline elapsed → light the first tile.
//   2. free AI match → run the bot's due claim for the live tile.
//   3. the live tile's window (plus the hidden network grace) elapsed →
//      resolve the tile as a BOTH-MISS (both players lose a life).
//
// Visibility model: the survival duel hides nothing mid-match. The live
// tile, both players' claimed tiles and both life counts are public by
// design — both players watch every tile resolve. What the payload does
// NOT carry is any server-only seed: the tile draw and the shrinking
// window are recomputed server-side on every read, so a client cannot
// look ahead at which tiles are coming.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../lib/auth/requireAgeVerified";
import {
  claimedTotal,
  currentWindowMs,
  enrichMatchesWithUsers,
  fetchMatchRounds,
  fetchMatchWithAutoResolve,
  scrubMatchForViewer,
} from "../../../../../lib/keno-pvp/serverStore";
import { getKenoCanonicalLifecycle } from "../../../../../lib/keno-pvp/canonicalLifecycleLookup";
import {
  KENO_POOL_SIZE,
  LIVE_STATES,
  MATCH_STATUS,
  STARTING_LIVES,
  TAP_GRACE_MS,
} from "../../../../../lib/keno-pvp/constants";
import { capTileLog } from "../../../../../lib/keno-pvp/engine";

function intOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// The claimed tile numbers for a log, per seat — the board's green (you)
// and gold (opponent) tiles, derived from the same public log both
// players already see in the feed.
function claimedTilesFromLog(log) {
  const p1 = [];
  const p2 = [];
  for (const entry of log) {
    const tile = Number(entry?.tile);
    if (!Number.isInteger(tile)) continue;
    if (entry.outcome === "player1") p1.push(tile);
    else if (entry.outcome === "player2") p2.push(tile);
  }
  return { p1, p2 };
}

// Per-viewer normaliser. Adds the derived flags the match view needs to
// gate the board, render the correct seat, and compute the claim window
// from the server clock.
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

  const isLive = LIVE_STATES.has(match.status);
  const liveTile = Number(match.liveTile);
  const hasTile = Number.isInteger(liveTile) && liveTile >= 1;

  const log = capTileLog(Array.isArray(match.tileLog) ? match.tileLog : [], KENO_POOL_SIZE);
  const claimed = claimedTilesFromLog(log);

  // The claim window in play RIGHT NOW (tightens with every claimed
  // tile), plus the deadline it was derived from. The client renders its
  // ring from these two values and the server clock, so the ring can
  // never disagree with the server's grading.
  const windowMs = currentWindowMs(match);
  const liveDeadline = match.roundDeadline ?? null;

  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    // Survival state — the scoreboard.
    p1Lives: Math.max(0, intOr(match.p1Lives, STARTING_LIVES)),
    p2Lives: Math.max(0, intOr(match.p2Lives, STARTING_LIVES)),
    p1Tiles: Math.max(0, intOr(match.p1Tiles)),
    p2Tiles: Math.max(0, intOr(match.p2Tiles)),
    claimedTotal: claimedTotal(match),
    // The live tile + its window.
    liveTile: hasTile && isLive ? liveTile : null,
    liveTileIndex: Math.max(0, intOr(match.liveTileIndex)),
    liveStartedAt: match.liveStartedAt ?? null,
    liveDeadline: isLive ? liveDeadline : null,
    windowMs,
    // How long after `liveDeadline` a tap is still honoured as a claim
    // (hidden network cushion — the client never renders it as time, it
    // only uses it to avoid calling a fresh tap "too late").
    tapGraceMs: TAP_GRACE_MS,
    usedCount: Array.isArray(match.usedTiles) ? match.usedTiles.length : 0,
    boardSize: KENO_POOL_SIZE,
    // Per-seat claimed tiles + the public per-tile feed.
    myClaimed: viewerIsPlayer1 ? claimed.p1 : viewerIsPlayer2 ? claimed.p2 : [],
    opponentClaimed: viewerIsPlayer1 ? claimed.p2 : viewerIsPlayer2 ? claimed.p1 : [],
    tileLog: log,
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
    // True when the viewer may claim the live tile right now. The server
    // re-validates the tile identity + window on every claim.
    viewerCanClaim: isLive && Boolean(viewerIsParticipant) && hasTile,
    // True when the viewer is the creator AND the match is still waiting
    // for an opponent. Used to gate the "Cancel" button.
    viewerCanCancel:
      match.status === MATCH_STATUS.WAITING && viewerIsPlayer1,
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
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

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

    const scrubbed = scrubMatchForViewer(enrichedMatch);

    // Legacy replay rows (pre-rework multi-round matches only).
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

    const canonicalLifecycle = await getKenoCanonicalLifecycle(matchId);

    return NextResponse.json({
      success: true,
      data: {
        canonicalLifecycle,
        // Server clock so the client can anchor its ring/board clock to
        // the authoritative grading clock — devices whose clock drifts
        // otherwise see the tile expire at the wrong moment.
        serverTime: Date.now(),
        match: normaliseMatch(scrubbed, userId),
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
