// src/app/api/lane-rush-duel/match/[matchId]/resign/route.js
//
// POST — resign from an active Lane Runner Duel match. The resigner
// forfeits their stake and the opponent is credited the pot minus
// the house fee (full settlement via the shared `resolveMatch`
// path in the server store). Mirrors the auth / async-params /
// error pattern of `cancel/route.js`.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { resignMatch } from "../../../../../../lib/lane-rush-duel/serverStore";
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
    const result = await resignMatch({ userId, matchId });
    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    broadcastMatchUpdate(matchId, {
      status: result.match?.status,
      resigned: true,
    });

    return NextResponse.json({
      success: true,
      data: {
        matchId,
        status: result.match?.status,
        resigned: true,
      },
    });
  } catch (error) {
    console.error("[lane-rush-duel/resign] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
