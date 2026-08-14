// src/app/api/keno-pvp/match/[matchId]/catch/route.js
//
// POST — register a catch attempt for the current round. The client
// sends the ball NUMBER it tapped; the server grades the tap against
// the ball's ideal catch instant using the SERVER clock (a client can
// never self-report a "perfect" catch) and appends the catch to the
// player's per-round ticket. One catch per ball per player; catches
// outside the ball's release window are rejected.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { catchBall } from "../../../../../../lib/keno-pvp/serverStore";
import { broadcastMatchUpdate } from "../../../../../../lib/keno-pvp/rooms";

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

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const ball = body?.ball;
  if (ball === undefined || ball === null) {
    return NextResponse.json(
      { success: false, error: "Missing ball" },
      { status: 400 },
    );
  }

  try {
    const result = await catchBall({ userId, matchId, ball });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort push so the opponent sees the catch count move
    // without waiting for the next poll.
    broadcastMatchUpdate(matchId, {
      caught: true,
      ball: result.catch?.number,
    });

    return NextResponse.json({
      success: true,
      data: {
        catch: result.catch,
        stats: result.stats,
        // True when this catch ended up being the round's last action
        // (the store resolved the round on this write).
        roundOver: !/^round_\d+$/.test(result.match.status || ""),
      },
    });
  } catch (error) {
    console.error("[keno-pvp/catch] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
