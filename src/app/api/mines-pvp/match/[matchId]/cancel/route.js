// src/app/api/mines-pvp/match/[matchId]/cancel/route.js
//
// POST — cancel a waiting match (creator only). Transitions status to
// 'cancelled'. Stakes are retired (matches are free), so there is nothing
// to refund. Mirrors
// `src/app/api/blackjack-pvp/match/[matchId]/cancel/route.js`.

import { NextResponse } from "next/server";
import { requirePracticePlayer } from "../../../../../../lib/auth/guestSession";
import { cancelMatch } from "../../../../../../lib/mines-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/mines-pvp/rooms";

export async function POST(req, { params }) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  const userId = gate.playerId;

  // Next.js 15+/16: API route `params` is a Promise — must await before
  // reading properties. Accessing it synchronously yields `undefined`,
  // which `Number(undefined)` coerces to `NaN`, which the finite-check
  // below rejects with "Invalid matchId" — masking the real match and
  // breaking the creator's cancel-lobby flow. Same fix applied to the
  // roulette-pvp and blackjack-pvp match routes.
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

    // Best-effort push to the match room so the cancel propagates
    // without waiting for the next poll. The helper internally
    // handles the no-op case when the realtime-server runs in a
    // separate process.
    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      cancelled: true,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match.status,
      },
    });
  } catch (error) {
    console.error("[mines-pvp/match/cancel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
