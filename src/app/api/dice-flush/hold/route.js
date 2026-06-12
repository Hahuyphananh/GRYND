import { NextResponse } from "next/server";
import { appendAction, db, eq, holdDice, loadRoom, requireUser, validateMove, diceFlushRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, heldDice } = await req.json();
    const next = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;
      validateMove(state, userId, "hold_dice", { heldDice });
      const updated = holdDice(state, heldDice);
      await tx.update(diceFlushRooms).set({ gameState: updated }).where(eq(diceFlushRooms.id, roomId));
      await appendAction(tx, roomId, userId, "hold_dice", { heldDice });
      return updated;
    });
    return NextResponse.json({ success: true, state: next });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
