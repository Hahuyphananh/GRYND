import { NextResponse } from "next/server";
import {
  appendAction,
  db,
  eq,
  farkleRooms,
  loadRoom,
  requireUser,
  recordFarkleLeaderboardResults,
  settleIfEnded,
} from "../_lib";
import { calculateScore, getScoringIndices, WINNING_SCORE } from "../../../../../game-engine/farkleEngine";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, indices } = await req.json();
    if (!roomId)
      return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      let state = room.gameState;

      if (state.state !== "playing") throw new Error("Game is not active");
      if (state.currentTurn !== userId) throw new Error("Not your turn");
      if (state.rollsThisTurn === 0 && state.turnScore <= 0) {
        throw new Error("Roll before banking");
      }

      // Bank should be resilient even if the client did not submit dice indices.
      // Prefer valid manual selections; otherwise auto-score all currently scoring dice.
      const submittedIndices = Array.isArray(indices) ? indices : [];
      const validSubmittedIndices = submittedIndices.filter(
        (idx) => Number.isInteger(idx) && idx >= 0 && idx < state.dice.length,
      );
      let indicesToScore = validSubmittedIndices;
      let selectedDice = indicesToScore.map((i) => state.dice[i]);
      let comboScore = selectedDice.length > 0 ? calculateScore(selectedDice) : 0;
      let autoSelected = validSubmittedIndices.length === 0;

      if (comboScore <= 0 && state.dice.length > 0) {
        autoSelected = true;
        indicesToScore = getScoringIndices(state.dice);
        selectedDice = indicesToScore.map((i) => state.dice[i]);
        comboScore = selectedDice.length > 0 ? calculateScore(selectedDice) : 0;
      }

      if (comboScore > 0) {
        state = {
          ...state,
          turnScore: state.turnScore + comboScore,
        };

        await appendAction(tx, roomId, userId, "select_scoring_dice", {
          indices: indicesToScore,
          comboScore,
          selectedDice,
          autoSelected,
        });
      }

      if (state.turnScore <= 0) throw new Error("No points to bank");

      // Add turn score to player's permanent score
      const currentScore = state.scores[userId] ?? 0;
      const bankedAmount = state.turnScore;
      const newTotal = currentScore + bankedAmount;

      const winningBank = newTotal >= WINNING_SCORE;

      if (winningBank) {
        state = {
          ...state,
          scores: { ...state.scores, [userId]: newTotal },
          turnScore: 0,
          currentTurn: userId,
          rollsThisTurn: 0,
          hasHotDice: false,
        };
      } else {
        // Pass turn to next player only when this bank does not immediately win.
        const idx = state.players.findIndex((p) => p.userId === userId);
        const nextPlayer = state.players[(idx + 1) % state.players.length];

        state = {
          ...state,
          scores: { ...state.scores, [userId]: newTotal },
          turnScore: 0,
          currentTurn: nextPlayer.userId,
          turnNumber: state.turnNumber + 1,
          rollsThisTurn: 0,
          dice: Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1),
          hasHotDice: false,
        };
      }

      await appendAction(tx, roomId, userId, "bank_score", {
        banked: bankedAmount,
        totalScore: newTotal,
      });

      // Check game end (no final round — immediate win at 10k+)
      const endedResult = await settleIfEnded(tx, room, state);

      // Check if AI is next after settlement. A winning bank must never schedule AI.
      const aiNext =
        !endedResult.ended &&
        endedResult.state.players.some((p) => p.isAI && p.userId === endedResult.state.currentTurn) &&
        endedResult.state.state === "playing";
      if (!endedResult.ended) {
        await tx
          .update(farkleRooms)
          .set({ gameState: endedResult.state })
          .where(eq(farkleRooms.id, roomId));
      }

      return { ...endedResult, aiNext, state: endedResult.state };
    });

    if (result.ended) {
      await recordFarkleLeaderboardResults(result);
    }

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed to bank score" },
      { status: 400 },
    );
  }
}
