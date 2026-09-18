// src/app/api/keno-pvp/match/[matchId]/cancel/route.js
//
// POST — cancel a waiting Keno Duel lobby. Creator only, while the
// match is still WAITING for an opponent (the creator's escrowed
// stake is refunded). Once an opponent has joined the match must play
// out or be forfeited via the disconnect path.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { cancelMatch } from "../../../../../../lib/keno-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/keno-pvp/rooms";

export async function POST(req, { params }) {
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
    const result = await cancelMatch({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      cancelled: true,
    });

    return NextResponse.json({
      success: true,
      data: { matchId },
    });
  } catch (error) {
    console.error("[keno-pvp/cancel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
