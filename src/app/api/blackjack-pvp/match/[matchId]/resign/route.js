// src/app/api/blackjack-pvp/match/[matchId]/resign/route.js
//
// POST — resign from a Blackjack PvP match (waiting or in-progress).
//   • Waiting lobby  → creator's stake refunded, match cancelled.
//   • Active match   → resigner forfeits their stake, opponent wins
//     the pot minus the house fee, match resolved as 'finished'.
// Mirrors the auth / async-params / error pattern of
// `src/app/api/blackjack-pvp/match/[matchId]/cancel/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resignMatch } from "../../../../../../lib/blackjack-pvp/serverStore";

// BUG-FIX (async params on Next.js 16): await `params` so `matchId`
// is the actual numeric segment instead of `undefined → NaN`, which
// would short-circuit the resign POST to a 400.
export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const resolvedParams = await params;
  const matchId = Number(resolvedParams?.matchId);
  if (!Number.isFinite(matchId)) {
    return NextResponse.json(
      { success: false, error: "Invalid matchId" },
      { status: 400 },
    );
  }

  try {
    const result = await resignMatch({ userId, matchId });
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
        refunded: Boolean(result.refunded),
        forfeited: Boolean(result.forfeited),
      },
    });
  } catch (error) {
    console.error("[blackjack-pvp/match/resign] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
