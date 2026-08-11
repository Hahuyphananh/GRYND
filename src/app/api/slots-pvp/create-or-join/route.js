// src/app/api/slots-pvp/create-or-join/route.js
//
// POST — stake-keyed matchmaking for PvP Slots:
//   1. Look for an open match with matching stake (different host).
//   2. If found → join it (deduct stake, transition status to
//      `ready` with a 3-second banner; spin_1 opens once the banner
//      expires via /status auto-advance).
//   3. Otherwise → create a fresh waiting match (deduct stake).
//
// The host may also pick the slot theme (mirrors mines-pvp's
// host-picked param); a joiner consumes whatever theme the host
// chose. Always returns the resulting match in a normalised shape so
// the frontend can react identically to "created" vs "joined".

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  createOrJoin,
  enrichMatchesWithUsers,
} from "../../../../lib/slots-pvp/serverStore.js";
import {
  MAX_STAKE,
  MIN_STAKE,
  pickPositiveInt,
} from "../../../../lib/slots-pvp/constants.js";
import { THEME_IDS } from "../../../../lib/slotThemes.jsx";
import { broadcastMatchUpdate } from "../../../../lib/slots-pvp/rooms.js";

function normaliseMatch(match) {
  if (!match) return null;
  return {
    id: match.id,
    player1Id: match.player1Id,
    player2Id: match.player2Id,
    stakeAmount: Number(match.stakeAmount),
    theme: match.theme || "fruit",
    status: match.status,
    currentSpin: match.currentSpin ?? 1,
    roundsWonPlayer1: Number(match.roundsWonPlayer1) || 0,
    roundsWonPlayer2: Number(match.roundsWonPlayer2) || 0,
    p1Score: Number(match.p1Score) || 0,
    p2Score: Number(match.p2Score) || 0,
    roundDeadline: match.roundDeadline,
    roundTimer: pickPositiveInt(match.roundTimerSeconds, 10),
    winnerId: match.winnerId ?? null,
    result: match.result ?? null,
    prizePaid: match.prizePaid ? Number(match.prizePaid) : 0,
    houseFee: match.houseFee ? Number(match.houseFee) : 0,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    createdAt: match.createdAt,
    players: match.players ?? null,
  };
}

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
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

  const stakeAmount = Number(body?.stakeAmount);
  if (!Number.isFinite(stakeAmount) || stakeAmount < MIN_STAKE) {
    return NextResponse.json(
      { success: false, error: "Invalid stake amount" },
      { status: 400 },
    );
  }
  if (stakeAmount > MAX_STAKE) {
    return NextResponse.json(
      { success: false, error: "Stake exceeds maximum limit" },
      { status: 400 },
    );
  }

  // Host-picked theme (only used when CREATING a lobby; a joiner
  // consumes the host's theme from the open-match row).
  let theme = "fruit";
  if (typeof body?.theme === "string" && THEME_IDS.includes(body.theme)) {
    theme = body.theme;
  }

  try {
    const result = await createOrJoin({ userId, stakeAmount, theme });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    const match = result.match;

    // Enrich with user names + profile images so the lobby / match
    // view can render proper player heads. Never crash the route on
    // lookup failure — enrichment is best-effort.
    let enrichedMatch = match;
    try {
      const e = await enrichMatchesWithUsers(match);
      if (e) enrichedMatch = e;
    } catch (err) {
      console.warn(
        "[slots-pvp/create-or-join] user enrichment failed:",
        err && err.message ? err.message : err,
      );
      enrichedMatch = match;
    }

    // Best-effort push to the match room so the opponent sees the
    // status flip (waiting → ready) without waiting for the next poll.
    broadcastMatchUpdate(match.id, {
      status: match.status,
      joined: Boolean(result.joined),
      created: !result.joined,
    });

    return NextResponse.json({
      success: true,
      data: {
        match: normaliseMatch(enrichedMatch),
        joined: Boolean(result.joined),
      },
    });
  } catch (error) {
    console.error("[slots-pvp/create-or-join] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
