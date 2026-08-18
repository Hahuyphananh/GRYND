// src/app/api/memory-grid/match/[matchId]/cancel/route.js
//
// POST — cancel a waiting match (creator only). Refunds the
// creator's stake and transitions status to 'cancelled'. Mirrors
// `src/app/api/mines-pvp/match/[matchId]/cancel/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cancelMatch } from "../../../../../../lib/memory-grid/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/memory-grid/rooms";

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  // Next.js 15+/16: API route `params` is a Promise — must await
  // before reading properties (same fix as the mines-pvp routes).
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
    // without waiting for the next poll.
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
    console.error("[memory-grid/match/cancel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
