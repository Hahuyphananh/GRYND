import { NextResponse } from "next/server";
import {
  appendAction,
  db,
  eq,
  farkleRooms,
  loadRoom,
  requireUser,
  settleIfEnded,
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
      let state = room.gameState;

      validateMove(state, userId, "bank_score");

      // If selected dice indices are provided, process scoring first
      if (indices && Array.isArray(indices) && indices.length > 0) {
        const selectedDice = indices.map((i) => state.dice[i]);
        const comboScore = calculateScore(selectedDice);
        if (comboScore <= 0)
          throw new Error("Selected dice are not a valid scoring combination");

        const newTurnScore = state.turnScore + comboScore;
        const hasMetThreshold = state.hasMetThreshold || newTurnScore >= MIN_BANK_THRESHOLD;

        state = {
          ...state,
          turnScore: newTurnScore,
          hasMetThreshold,
        };

        await appendAction(tx, roomId, userId, "select_scoring_dice", {
          indices,
          comboScore,
          selectedDice,
        });
      }

      // Add turn score to player's permanent score
      const currentScore = state.scores[userId] ?? 0;
      const bankedAmount = state.turnScore; // capture before reset
      const newTotal = currentScore + bankedAmount;

      // Pass turn to next player
      const idx = state.players.findIndex((p) => p.userId === userId);
      const nextPlayer = state.players[(idx + 1) % state.players.length];

      state = {
        ...state,
        scores: { ...state.scores, [userId]: newTotal },
        turnScore: 0,
        hasMetThreshold: false,
        currentTurn: nextPlayer.userId,
        turnNumber: state.turnNumber + 1,
        rollsThisTurn: 0,
        dice: Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1),
        hasHotDice: false,
      };

      await appendAction(tx, roomId, userId, "bank_score", {
        banked: bankedAmount,
        totalScore: newTotal,
      });

      // Check if AI is next
      const aiNext =
        state.players.some((p) => p.isAI && p.userId === state.currentTurn) &&
        state.state === "playing";

      // Check game end
      const endedResult = await settleIfEnded(tx, room, state);
      if (!endedResult.ended) {
        await tx
          .update(farkleRooms)
          .set({ gameState: state })
          .where(eq(farkleRooms.id, roomId));
      }

      return { ...endedResult, aiNext, state: endedResult.ended ? endedResult.state : state };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed to bank score" },
      { status: 400 },
    );
  }
}
