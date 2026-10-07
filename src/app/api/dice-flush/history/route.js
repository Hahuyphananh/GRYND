import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "../../../../db/client";
import { diceFlushActions } from "../../../../db/schema";
import { assertRoomSeat, errorStatus, loadRoom } from "../_lib";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";

export async function GET(req) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");
    if (!roomId) throw new Error("roomId required");

    // Per-room owner check: the move log of a room is only visible to a
    // caller holding a seat in it.
    const room = await loadRoom(roomId);
    assertRoomSeat(room.gameState, userId);

    const actions = await db
      .select()
      .from(diceFlushActions)
      .where(eq(diceFlushActions.roomId, roomId))
      .orderBy(asc(diceFlushActions.createdAt))
      .limit(200);

    return NextResponse.json({ success: true, actions });
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: e.message || "Failed to fetch history",
    }, { status: errorStatus(e) });
  }
}
