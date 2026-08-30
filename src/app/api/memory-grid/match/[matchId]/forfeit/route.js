// src/app/api/memory-grid/match/[matchId]/forfeit/route.js
//
// POST — forfeit from an active Memory Grid match (user-initiated
// surrender, mirroring the disconnect-forfeit path but authenticated
// via the Clerk session instead of a socket token). The forfeiter
// loses and the opponent is credited the pot minus the house fee;
// a WAITING match is cancelled with a full refund. Idempotent —
// terminal matches are left untouched.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { forfeitMatch } from "../../../../../../lib/memory-grid/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/memory-grid/rooms";

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
    const result = await forfeitMatch({ loserClerkId: userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match.status,
      forfeited: result.forfeited === true,
      cancelled: result.cancelled === true,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match.status,
        forfeited: result.forfeited === true,
        cancelled: result.cancelled === true,
      },
    });
  } catch (err) {
    console.error("[memory-grid:forfeit]", err);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
