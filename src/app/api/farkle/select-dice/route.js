import { NextResponse } from "next/server";
import {
  appendAction,
  db,
  eq,
  farkleRooms,
  loadRoom,
  requireUser,
  validateMove,
} from "../_lib";
import {
  calculateScore,
  MIN_BANK_THRESHOLD,
} from "../../../../../game-engine/farkleEngine";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, indices } = await req.json();
    if (!roomId)
      return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;

      validateMove(state, userId, "select_scoring_dice", { indices });

      // Get the selected dice values and validate they form a scoring combination
      const selectedDice = indices.map((i) => state.dice[i]);
      const comboScore = calculateScore(selectedDice);
      if (comboScore <= 0)
        throw new Error("Selected dice are not a valid scoring combination");

      // Determine remaining dice
      const remaining = state.dice.filter((_, i) => !indices.includes(i));

      const newTurnScore = state.turnScore + comboScore;
      const hasMetThreshold = state.hasMetThreshold || newTurnScore >= MIN_BANK_THRESHOLD;

      let next;
      // If all dice were selected (hot dice scenario)
      if (remaining.length === 0) {
        next = {
          ...state,
          turnScore: newTurnScore,
          hasMetThreshold,
          dice: Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1),
          hasHotDice: true,
          rollsThisTurn: state.rollsThisTurn,
        };
      } else {
        next = {
          ...state,
          turnScore: newTurnScore,
          hasMetThreshold,
          dice: remaining,
          hasHotDice: false,
        };
      }

      await tx.update(farkleRooms).set({ gameState: next }).where(eq(farkleRooms.id, roomId));
      await appendAction(tx, roomId, userId, "select_scoring_dice", {
        indices,
        comboScore,
        selectedDice,
      });

      return next;
    });

    return NextResponse.json({ success: true, state: result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed to select dice" },
      { status: 400 },
    );
  }
}
