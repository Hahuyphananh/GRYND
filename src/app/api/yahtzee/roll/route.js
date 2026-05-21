import { NextResponse } from "next/server";
import { appendAction, db, eq, loadRoom, requireUser, rollDice, validateMove, yahtzeeRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    const next = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;
      validateMove(state, userId, "roll_dice");
      const updated = rollDice(state);
      await tx.update(yahtzeeRooms).set({ gameState: updated }).where(eq(yahtzeeRooms.id, roomId));
      await appendAction(tx, roomId, userId, "roll_dice", {});
      return updated;
    });
    return NextResponse.json({ success: true, state: next });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
