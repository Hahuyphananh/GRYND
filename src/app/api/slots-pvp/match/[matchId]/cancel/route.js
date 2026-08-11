// src/app/api/slots-pvp/match/[matchId]/cancel/route.js
//
// POST — cancel a waiting slots-pvp match (creator only). Refunds the
// creator's stake and transitions status to 'cancelled'. Mirrors the
// plinko-pvp / mines-pvp cancel routes.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cancelMatch } from "../../../../../../lib/slots-pvp/serverStore.js";
import { broadcastMatchUpdate } from "../../../../../../lib/slots-pvp/rooms.js";

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

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
    const result = await cancelMatch({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push so the cancel propagates without waiting for
    // the next poll.
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
    console.error("[slots-pvp/match/cancel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
