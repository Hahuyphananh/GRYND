// src/app/api/lane-rush-duel/match/[matchId]/cancel/route.js
//
// POST — cancel a waiting match (creator only, before opponent
// joins). Refunds the creator's stake.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cancelMatch } from "../../../../../../lib/lane-rush-duel/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/lane-rush-duel/rooms";

export async function POST(req, { params }) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

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
      status: result.match?.status,
      cancelled: true,
    });

    return NextResponse.json({ success: true, data: { match: result.match } });
  } catch (error) {
    console.error("[lane-rush-duel/cancel] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
