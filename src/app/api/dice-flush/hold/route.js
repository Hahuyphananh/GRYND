import { NextResponse } from "next/server";
import { appendAction, db, eq, holdDice, loadRoom, requireUser, resolveExpiredTurn, validateMove, diceFlushRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, heldDice } = await req.json();
    const next = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      // Shot clock: resolve a stalled turn before processing the move.
      const resolved = await resolveExpiredTurn(tx, room, room.gameState);
      if (resolved.didTimeout) {
        return { success: false, error: "Turn expired. Best category auto-banked.", state: resolved.state, status: 409 };
      }
      validateMove(resolved.state, userId, "hold_dice", { heldDice });
      const updated = holdDice(resolved.state, heldDice);
      await tx.update(diceFlushRooms).set({ gameState: updated }).where(eq(diceFlushRooms.id, roomId));
      await appendAction(tx, roomId, userId, "hold_dice", { heldDice });
      return { success: true, state: updated };
    });
    return NextResponse.json(next, { status: next.status ?? 200 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
