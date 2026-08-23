import { NextResponse } from "next/server";
import { callCategory } from "../../../../../game-engine/diceFlushEngine";
import { appendAction, db, eq, loadRoom, requireUser, resolveExpiredTurn, diceFlushRooms } from "../_lib";

// POST /api/dice-flush/call
//
// Skill layer — "call the category". The current player secretly commits to
// one unfilled category BEFORE their first roll. If they bank that category
// later in the turn they earn the CALL_BONUS (+15) on top of the category
// score. The server enforces: must be your turn, must be before the first
// roll, one call per turn, and the category must still be unfilled.

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, category } = await req.json();
    if (!roomId || !category) {
      return NextResponse.json({ success: false, error: "roomId and category required" }, { status: 400 });
    }
    const next = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      // Shot clock: resolve a stalled turn before processing the move.
      const resolved = await resolveExpiredTurn(tx, room, room.gameState);
      if (resolved.didTimeout) {
        return { success: false, error: "Turn expired. Best category auto-banked.", state: resolved.state, status: 409 };
      }
      const updated = callCategory(resolved.state, category);
      await tx.update(diceFlushRooms).set({ gameState: updated }).where(eq(diceFlushRooms.id, roomId));
      await appendAction(tx, roomId, userId, "call_category", { category });
      return { success: true, state: updated };
    });
    return NextResponse.json(next, { status: next.status ?? 200 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
