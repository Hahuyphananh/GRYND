// src/app/api/blackjack-pvp/match/[matchId]/cancel/route.js
//
// POST — cancel a waiting match (creator only). Refunds the
// creator's stake and transitions status to 'cancelled'.
// Mirrors `src/app/api/roulette-pvp/match/[matchId]/cancel/route.js`.

import { NextResponse } from "next/server";
import { requireAgeVerifiedUser } from "../../../../../../lib/auth/requireAgeVerified";
import { cancelMatch } from "../../../../../../lib/blackjack-pvp/serverStore";

// BUG-FIX (async params on Next.js 16): await `params` so `matchId`
// is the actual numeric segment instead of `undefined → NaN`, which
// would short-circuit the cancel POST to a 400 and block the
// creator's "Cancel" button while their opponent is waiting.
export async function POST(req, { params }) {
  const gate = await requireAgeVerifiedUser();
  if (gate.response) return gate.response;
  const userId = gate.userId;

  const resolvedParams = await params;
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

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match.status,
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/match/cancel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
