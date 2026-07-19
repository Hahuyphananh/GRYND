// src/app/api/plinko-pvp/match/[matchId]/launch/route.js
//
// POST — submit a per-ball commit (startX / power / angleDeg).
// Server-side authoritative:
//   • status must be in LAUNCHABLE_STATES (ball_1/2/3)
//   • the player must not have already committed for this ball
//     (one-shot lock-in — matches roulette-pvp's anti-cheat
//     pattern so a player can't rewrite their inputs at the last
//     millisecond to scrub the result)
//   • round deadline must not have elapsed (the next /status
//     poll triggers the AFK auto-launch instead)
//
// The route is intentionally thin: it forwards (startX, power,
// angleDeg) to `launchBall` in the server store, which performs:
//   • participant + launchable-state validation
//   • FOR UPDATE row lock so two parallel launchBall calls
//     (different players, same ball) serialise correctly
//   • one-shot lock-in via in-memory `if (match.p{N}CurrentInputs)`
//     after the lock
//   • deterministic per-ball seed via hashSeed
//   • physics simulation + result caching on the match row
//   • synchronous ball resolution if both seats are now in
//     (calls resolveBall internally, which inserts the rounds
//     row + advances the state)
//
// Response shape:
//   {
//     match:     normalised match state (post-UPDATE / post-resolve),
//     myResult:  caller's own simulation result (with path) — for
//                immediate ball animation in the commit panel,
//     p1Result:  p1's cached result (with path) — non-null while
//                p1CurrentInputs is set, null after the ball
//                resolves (use the rounds row for historical paths),
//     p2Result:  mirror of p1Result for p2,
//     justResolved: true if this commit filled the last gap and
//                the ball was resolved server-side,
//     raced:     true if a concurrent commit raced past (e.g. the
//                same player double-clicked "Launch" — the client
//                should re-fetch /status to see the actual state),
//   }

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  enrichMatchesWithUsers,
  launchBall,
} from "../../../../../../lib/plinko-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/plinko-pvp/rooms";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentBall: match.currentBall ?? 1,
    p1Score: match.p1Score ?? 0,
    p2Score: match.p2Score ?? 0,
    p1CurrentInputs: match.p1CurrentInputs || null,
    p2CurrentInputs: match.p2CurrentInputs || null,
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
    // enrichMatchesWithUsers below — the match view uses these to
    // render real names instead of truncation. Without this the
    // match view shows "user_xxxx…" after each commit bounce.
    players: match.players ?? null,
  };
}

function normaliseBallResult(result) {
  if (!result) return null;
  return {
    path: result.path || [],
    fellOut: Boolean(result.fellOut),
    finalX: result.finalX,
    finalY: result.finalY,
    bucketIndex: result.bucketIndex,
    points: result.points ?? 0,
  };
}

export async function POST(req, { params }) {
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

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Defensive input validation. The server store re-validates with
  // tighter range checks (power in [0,100], angleDeg in [-45,45],
  // startX in [0,500]) so a malformed payload lands as a 400 here
  // with a friendly message.
  const startX = Number(body?.startX);
  const power = Number(body?.power);
  const angleDeg = Number(body?.angleDeg);
  if (
    !Number.isFinite(startX) ||
    !Number.isFinite(power) ||
    !Number.isFinite(angleDeg)
  ) {
    return NextResponse.json(
      { success: false, error: "startX, power, angleDeg must be numbers" },
      { status: 400 },
    );
  }

  try {
    const result = await launchBall({
      userId,
      matchId,
      startX,
      power,
      angleDeg,
    });
    if (result.error) {
      // Surface optional `code` so the client can render a targeted
      // migration-needed message instead of a generic toast. The
      // MIGRATION_INCOMPLETE code is emitted by serverStore.js when
      // p1_ready / p2_ready columns are missing on the live DB (see
      // ensurePlinkoReadyColumns).
      const body = { success: false, error: result.error };
      if (result.code) body.code = result.code;
      return NextResponse.json(body, { status: result.status || 400 });
    }

    // Enrich with user names + profile images so the match view can
    // render proper player heads. Best-effort — never crash the route.
    let enrichedMatch = result.match;
    try {
      const e = await enrichMatchesWithUsers(result.match);
      if (e) enrichedMatch = e;
    } catch (err) {
      console.warn(
        "[plinko-pvp/match/launch] user enrichment failed:",
        err && err.message ? err.message : err,
      );
      enrichedMatch = result.match;
    }

    // Best-effort push to the match room so the opponent sees the
    // commit without waiting for the 1.5s poll. The helper internally
    // handles the no-op case when the realtime-server runs in a
    // separate process.
    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      justResolved: Boolean(result.justResolved),
      ballNumber: result.match?.currentBall,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(enrichedMatch),
        myResult: normaliseBallResult(result.myResult),
        p1Result: normaliseBallResult(result.p1Result),
        p2Result: normaliseBallResult(result.p2Result),
        justResolved: Boolean(result.justResolved),
        raced: Boolean(result.raced),
      },
    });
  } catch (error) {
    // Capture stack so 500s after the first round are debuggable
    // from server logs. Wrapping the entire launch flow means even
    // if a downstream bug in resolveBall / forceBallAdvance throws,
    // we surface the error instead of swallowing it. (Previously
    // some errors bubbled up as opaque 500s with no log line.)
    console.error(
      "[plinko-pvp/match/launch] error:",
      error && error.stack ? error.stack : error,
    );
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
