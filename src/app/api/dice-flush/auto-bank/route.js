import { NextResponse } from "next/server";
import { db, eq, loadRoom, requireUser, resolveExpiredTurn, diceFlushRooms } from "../_lib";

// POST /api/dice-flush/auto-bank
//
// Shot clock — the client calls this when the visible turn countdown hits
// zero so the turn resolves immediately instead of waiting for the next
// poll. Idempotent: if the turn hasn't actually expired (or already
// advanced), the current state is returned unchanged.

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId) {
      return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });
    }
    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const resolved = await resolveExpiredTurn(tx, room, room.gameState);
      return { success: true, state: resolved.state, didTimeout: resolved.didTimeout };
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
