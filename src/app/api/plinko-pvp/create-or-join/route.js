// src/app/api/plinko-pvp/create-or-join/route.js
//
// POST — stake-keyed matchmaking for Plinko Duel:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition status to
//      `ready` with a 3-second banner; ball_1 opens once the
//      banner expires via /status auto-advance).
//   3. Otherwise → create a fresh waiting match (deduct stake).
//
// Unlike mines-pvp there's no host-picked game param (mine count)
// — the only player input at create time is the stake. The joiner
// just consumes whatever stake the host picked.
//
// Always returns the resulting match in a normalised shape so the
// frontend can react identically to "created" vs "joined".

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import {
  createOrJoin,
  enrichMatchesWithUsers,
} from "../../../../lib/plinko-pvp/serverStore";
import { pickPositiveInt } from "../../../../lib/plinko-pvp/constants";
import { normalizeStake } from "../../../../lib/games/stakes";
import { broadcastMatchUpdate } from "../../../../lib/plinko-pvp/rooms";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    isAi: Boolean(match.isAi),
    stakeAmount: Number(match.stakeAmount),
    status: match.status,
    currentBall: match.currentBall ?? 1,
    p1Score: Number(match.p1Score) || 0,
    p2Score: Number(match.p2Score) || 0,
    // p1/p2CurrentInputs are the "ball in flight" indicators. They're
    // cleared after the ball resolves; the client can use them to
    // render a "waiting for opponent" hint on the commit panel.
    p1CurrentInputs: match.p1CurrentInputs || null,
    p2CurrentInputs: match.p2CurrentInputs || null,
    roundDeadline: match.roundDeadline,
    // Strict positive-int guard via shared helper — stays in lockstep
    // with the other plinko-pvp routes.
    roundTimer: pickPositiveInt(match.roundTimerSeconds, 20),
    winnerId: match.winnerId ?? null,
    result: match.result ?? null,
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    // Player heads (displayName + official iconKey) so the lobby and
    // match view can render proper names, not truncation. See
    // serverStore.js `enrichMatchesWithUsers` for the source.
    players: match.players ?? null,
  };
}

export async function POST(req) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // STAKES ARE RETIRED (src/lib/games/stakes.js): a match is free to enter.
  // The requested stake is normalized to 0 so no range check can reject a
  // free match, and the store's escrow/payout arithmetic runs against 0.
  const stakeAmount = normalizeStake(body?.stakeAmount);

  try {
    const result = await createOrJoin({ userId, stakeAmount });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    const match = result.match;

    // Enrich with user names + profile images so the lobby / match view
    // can render proper player heads instead of truncation. Never crash
    // the route on lookup failure — enrichment is best-effort.
    let enrichedMatch = match;
    try {
      const e = await enrichMatchesWithUsers(match);
      if (e) enrichedMatch = e;
    } catch (err) {
      console.warn(
        "[plinko-pvp/create-or-join] user enrichment failed:",
        err && err.message ? err.message : err,
      );
      enrichedMatch = match;
    }

    // Best-effort push to the match room so the opponent sees the
    // status flip (waiting → ready) without waiting for the next
    // 1.5s poll. The helper internally handles the no-op case when
    // the realtime-server runs in a separate process.
    if (result.joined) {
      broadcastMatchUpdate(match.id, {
        status: match.status,
        joined: true,
      });
    } else {
      broadcastMatchUpdate(match.id, {
        status: match.status,
        created: true,
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(enrichedMatch),
        joined: Boolean(result.joined),
      },
    });
  } catch (error) {
    console.error("[plinko-pvp/create-or-join] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
