import { NextResponse } from "next/server";
import {
  appendAction,
  db,
  eq,
  farkleRooms,
  loadRoom,
  processRollResult,
  requireUser,
  validateMove,
} from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId)
      return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;

      validateMove(state, userId, "roll_dice");

      // Re-roll the current dice
      const count = state.hasHotDice ? 6 : state.dice.length;
      const newDice = Array.from({ length: count }, () => Math.floor(Math.random() * 6) + 1);

      let next = {
        ...state,
        dice: newDice,
        rollsThisTurn: state.rollsThisTurn + 1,
        hasHotDice: false,
      };

      // Process roll result (check for Farkle)
      next = processRollResult(next);

      await tx.update(farkleRooms).set({ gameState: next }).where(eq(farkleRooms.id, roomId));
      await appendAction(tx, roomId, userId, "roll_dice", { dice: newDice });

      return next;
    });

    return NextResponse.json({ success: true, state: result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed to roll dice" },
      { status: 400 },
    );
  }
}
