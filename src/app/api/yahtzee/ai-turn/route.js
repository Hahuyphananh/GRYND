import { NextResponse } from "next/server";
import { calculateScore, rollDice } from "../../../../../game-engine/yahtzeeEngine";
import { appendAction, db, eq, loadRoom, nextTurn, requireUser, settleIfEnded, validateMove, yahtzeeRooms } from "../_lib";

const ALL_CATEGORIES = ["ones","twos","threes","fours","fives","sixes","threeOfKind","fourOfKind","fullHouse","smallStraight","largeStraight","yahtzee","chance"];

function pickAiCategory(state) {
  const aiPlayer = state.players.find(p => p.isAI && p.userId === state.currentTurn);
  if (!aiPlayer) return null;
  const used = state.scorecards[aiPlayer.userId] ?? {};
  const options = ALL_CATEGORIES
    .filter((c) => used[c] === undefined)
    .map((category) => ({ category, score: calculateScore(state.dice, category) }));
  options.sort((a,b)=>b.score-a.score);
  return options[Math.min(options.length - 1, Math.floor(Math.random() < 0.15 ? Math.random() * Math.min(options.length, 3) : 0))].category;
}

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId) return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      let state = room.gameState;

      // Only process if it's actually an AI's turn
      const aiPlayer = state.players.find(p => p.isAI && p.userId === state.currentTurn);
      if (!aiPlayer) throw new Error("Not an AI turn");
      if (state.state !== "playing") throw new Error("Game not active");

      // Roll dice up to 3 times, collecting step data for animation
      const rollSteps = [];
      for (let i = 0; i < 3; i++) {
        state = rollDice(state);
        rollSteps.push({ dice: [...state.dice], heldDice: [...state.heldDice], rollNum: state.rollsThisTurn });
        await appendAction(tx, roomId, aiPlayer.userId, "roll", {});
      }

      // Pick best category
      const category = pickAiCategory(state);
      const score = calculateScore(state.dice, category);
      state = nextTurn(state, aiPlayer.userId, category);
      await appendAction(tx, roomId, aiPlayer.userId, "choose_category", { category, score });

      // Check game end
      const endedResult = await settleIfEnded(tx, room, state);
      if (!endedResult.ended) {
        await tx.update(yahtzeeRooms).set({ gameState: state }).where(eq(yahtzeeRooms.id, roomId));
      }

      return {
        ...endedResult,
        state: endedResult.ended ? endedResult.state : state,
        rollSteps,
        aiCategory: category,
        aiScore: score,
      };
    });

    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
