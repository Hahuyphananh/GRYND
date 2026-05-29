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
import { calculateScore } from "../../../../../game-engine/farkleEngine";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, indices } = await req.json();
    if (!roomId)
      return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      let state = room.gameState;

      validateMove(state, userId, "roll_dice");

      // If selected dice indices are provided, process scoring first
      if (indices && Array.isArray(indices) && indices.length > 0) {
        const selectedDice = indices.map((i) => state.dice[i]);
        const comboScore = calculateScore(selectedDice);
        if (comboScore <= 0)
          throw new Error("Selected dice are not a valid scoring combination");

        const remainingDice = state.dice.filter((_, i) => !indices.includes(i));
        const newTurnScore = state.turnScore + comboScore;

        state = {
          ...state,
          turnScore: newTurnScore,
          dice: remainingDice,
          hasHotDice: false,
        };

        await appendAction(tx, roomId, userId, "select_scoring_dice", {
          indices,
          comboScore,
          selectedDice,
        });

        // If all dice were selected (hot dice scenario), auto-roll all 6
        if (remainingDice.length === 0) {
          const hotDice = Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1);
          let next = {
            ...state,
            dice: hotDice,
            hasHotDice: true,
            rollsThisTurn: state.rollsThisTurn + 1,
          };
          next = processRollResult(next);
          await tx.update(farkleRooms).set({ gameState: next }).where(eq(farkleRooms.id, roomId));
          await appendAction(tx, roomId, userId, "roll_dice", { dice: hotDice, hotDiceReroll: true });
          return next;
        }
      } else {
        // Player must select at least one scoring die if scoring dice are available,
        // unless this is the first roll of the turn (rollsThisTurn === 0)
        if (state.rollsThisTurn > 0 && calculateScore(state.dice) > 0 && state.dice.length > 0) {
          throw new Error("You must select at least one scoring die before rolling");
        }
        // If no scoring dice available, it will be detected as a Farkle below
      }

      // Re-roll the current dice
      const count = state.hasHotDice ? 6 : state.dice.length;
      if (count <= 0)
        throw new Error("No dice to roll — bank your score first");

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
