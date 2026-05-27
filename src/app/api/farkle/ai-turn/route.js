import { NextResponse } from "next/server";
import {
  aiDecide,
  aiShouldBank,
  calculateScore,
  isFarkle,
  isHotDice,
  WINNING_SCORE,
} from "../../../../../game-engine/farkleEngine";
import {
  appendAction,
  db,
  eq,
  farkleRooms,
  loadRoom,
  requireUser,
  settleIfEnded,
} from "../_lib";

/**
 * Run the AI's full turn: select scoring dice, decide whether to bank or roll,
 * and handle Farkles. Returns step-by-step data for client animation.
 */
async function executeAiTurn(tx, state, room, aiPlayer) {
  const steps = [];
  const difficulty = aiPlayer.difficulty ?? "medium";

  // AI's turn loop
  let currentState = { ...state };
  let turnOver = false;

  while (!turnOver) {
    // Check if current dice are a Farkle
    if (isFarkle(currentState.dice)) {
      currentState = {
        ...currentState,
        turnScore: 0,
        hasMetThreshold: false,
      };
      steps.push({ type: "farkle", dice: [...currentState.dice] });
      turnOver = true;
      break;
    }

    // AI selects scoring dice
    const decision = aiDecide(currentState);
    if (decision.action === "select") {
      const selectedDice = decision.indices.map((i) => currentState.dice[i]);
      const comboScore = calculateScore(selectedDice);
      const remaining = currentState.dice.filter((_, i) => !decision.indices.includes(i));

      const newTurnScore = currentState.turnScore + comboScore;
      const hasMetThreshold =
        currentState.hasMetThreshold || newTurnScore >= 500;

      steps.push({
        type: "select",
        indices: decision.indices,
        selectedDice,
        comboScore,
        remainingCount: remaining.length,
      });

      // Check for hot dice
      if (remaining.length === 0) {
        currentState = {
          ...currentState,
          turnScore: newTurnScore,
          hasMetThreshold,
          dice: Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1),
          hasHotDice: true,
          rollsThisTurn: currentState.rollsThisTurn,
        };
        steps.push({ type: "hot_dice", newDice: [...currentState.dice] });
        continue;
      }

      currentState = {
        ...currentState,
        turnScore: newTurnScore,
        hasMetThreshold,
        dice: remaining,
        hasHotDice: false,
      };

      // Decide whether to bank
      const shouldBank = aiShouldBank(currentState);

      // Check if we already won
      const currentScore = currentState.scores[aiPlayer.userId] ?? 0;
      if (currentScore + currentState.turnScore >= WINNING_SCORE) {
        shouldBank === true;
      }

      if (shouldBank) {
        steps.push({
          type: "bank",
          turnScore: currentState.turnScore,
          totalScore: currentScore + currentState.turnScore,
        });
        turnOver = true;
      } else {
        // Roll remaining dice
        const newDice = Array.from(
          { length: currentState.dice.length },
          () => Math.floor(Math.random() * 6) + 1,
        );
        steps.push({ type: "roll", dice: [...newDice], remainingDice: currentState.dice.length });

        currentState = {
          ...currentState,
          dice: newDice,
          rollsThisTurn: currentState.rollsThisTurn + 1,
          hasHotDice: false,
        };
      }
    } else {
      // Bank
      const currentScore = currentState.scores[aiPlayer.userId] ?? 0;
      steps.push({
        type: "bank",
        turnScore: currentState.turnScore,
        totalScore: currentScore + currentState.turnScore,
      });
      turnOver = true;
    }
  }

  return { steps, finalState: currentState };
}

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId)
      return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      let state = room.gameState;

      // Only process if it's actually an AI's turn
      const aiPlayer = state.players.find(
        (p) => p.isAI && p.userId === state.currentTurn,
      );
      if (!aiPlayer) throw new Error("Not an AI turn");
      if (state.state !== "playing") throw new Error("Game not active");

      // Execute the AI's full turn
      const { steps, finalState } = await executeAiTurn(tx, state, room, aiPlayer);

      // If the AI banked (turn ended), pass the turn and check for game end
      let nextState = finalState;
      if (steps.some((s) => s.type === "bank") || steps.some((s) => s.type === "farkle")) {
        // Pass turn to next player
        const idx = state.players.findIndex((p) => p.userId === state.currentTurn);
        const nextPlayer = state.players[(idx + 1) % state.players.length];

        if (steps.some((s) => s.type === "bank")) {
          // Add AI's turn score to their permanent score
          const currentScore = nextState.scores[aiPlayer.userId] ?? 0;
          const newTotal = currentScore + nextState.turnScore;
          nextState.scores = { ...nextState.scores, [aiPlayer.userId]: newTotal };
        }

        nextState = {
          ...nextState,
          turnScore: 0,
          hasMetThreshold: false,
          currentTurn: nextPlayer.userId,
          turnNumber: state.turnNumber + 1,
          rollsThisTurn: 0,
          dice: Array.from({ length: 6 }, () => Math.floor(Math.random() * 6) + 1),
          hasHotDice: false,
        };
      }

      // Log actions
      for (const step of steps) {
        await appendAction(tx, roomId, aiPlayer.userId, `ai_${step.type}`, step);
      }

      // Check game end
      const endedResult = await settleIfEnded(tx, room, nextState);
      if (!endedResult.ended) {
        await tx
          .update(farkleRooms)
          .set({ gameState: nextState })
          .where(eq(farkleRooms.id, roomId));
      }

      return {
        ...endedResult,
        state: endedResult.ended ? endedResult.state : nextState,
        steps,
      };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "AI turn failed" },
      { status: 400 },
    );
  }
}
