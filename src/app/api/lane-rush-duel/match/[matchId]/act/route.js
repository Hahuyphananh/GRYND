// src/app/api/lane-rush-duel/match/[matchId]/act/route.js
//
// POST — perform a turn action: pick a tile (`action: "pick"` with
// `tileIndex`) or bank your lane (`action: "hold"`). The server
// store validates the turn + deadline and either advances the turn
// or resolves the match, all inside one transaction.

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { act } from "../../../../../../lib/lane-rush-duel/serverStore";
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

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const action = String(body?.action || "");
  const path = String(body?.path || "");
  const tileIndex = body?.tileIndex;

  try {
    const result = await act({ userId, matchId, action, path, tileIndex });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status || 400 },
      );
    }

    // Best-effort live push to the per-match room so the opponent's
    // status poll fires inside ~50ms instead of waiting 1.5s.
    broadcastMatchUpdate(matchId, {
      status: result.status,
      action,
    });

    return NextResponse.json({
      success: true,
      data: {
        status: result.status,
        result: result.result ?? null,
        winnerId: result.winnerId ?? null,
      },
    });
  } catch (error) {
    console.error("[lane-rush-duel/act] error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
