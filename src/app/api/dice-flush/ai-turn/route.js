import { NextResponse } from "next/server";
import { calculateScore, rollDice } from "../../../../../game-engine/diceFlushEngine";
import { appendAction, db, eq, loadRoom, nextTurn, requireUser, resolveExpiredTurn, settleIfEnded, validateMove, diceFlushRooms } from "../_lib";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { chooseAiOption, coerceAiDifficulty } from "../../../../lib/aiDifficulty";

const ALL_CATEGORIES = ["ones","twos","threes","fours","fives","sixes","threeOfKind","fourOfKind","fullHouse","smallStraight","largeStraight","fiveKind"];

// AI picks from the SHARED sheet — only categories nobody has claimed yet.
// The tier decides how often it settles for a weaker category instead of the
// best-scoring open one (see `chooseAiOption` in the shared AI scale).
function pickAiCategory(state, difficulty) {
  const options = ALL_CATEGORIES
    .filter((c) => state.scorecards[c] === undefined)
    .map((category) => ({ category, score: calculateScore(state.dice, category) }));
  const picked = chooseAiOption(difficulty, options, (option) => option.score);
  return picked ? picked.category : null;
}

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId) return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      let state = room.gameState;

      // Shot clock: resolve a stalled turn (e.g. the human's previous turn
      // expired while the client was still animating) before proceeding.
      const resolved = await resolveExpiredTurn(tx, room, state);
      state = resolved.state;

      // Only process if it's actually an AI's turn
      const aiPlayer = state.players.find(p => p.isAI && p.userId === state.currentTurn);
      if (!aiPlayer) throw new Error("Not an AI turn");
      if (state.state !== "playing") throw new Error("Game not active");

      // Skill layer — the AI also "calls" a random open category before its
      // first roll, so the call bonus is symmetric (and occasionally lands).
      if (state.currentCall === null) {
        const open = ALL_CATEGORIES.filter(c => state.scorecards[c] === undefined);
        if (open.length > 0) {
          state.currentCall = open[Math.floor(Math.random() * open.length)];
          await appendAction(tx, roomId, aiPlayer.userId, "call_category", { category: state.currentCall });
        }
      }

      // Roll dice up to 3 times, collecting step data for animation
      const rollSteps = [];
      for (let i = 0; i < 3; i++) {
        state = rollDice(state);
        rollSteps.push({ dice: [...state.dice], heldDice: [...state.heldDice], rollNum: state.rollsThisTurn });
        await appendAction(tx, roomId, aiPlayer.userId, "roll", {});
      }

      // Pick best category from the shared sheet
      const category = pickAiCategory(state, coerceAiDifficulty(aiPlayer.difficulty));
      if (!category) throw new Error("No categories left");
      const score = calculateScore(state.dice, category);
      state = nextTurn(state, aiPlayer.userId, category);
      await appendAction(tx, roomId, aiPlayer.userId, "choose_category", { category, score });

      // Check game end
      const endedResult = await settleIfEnded(tx, room, state);
      if (!endedResult.ended) {
        await tx.update(diceFlushRooms).set({ gameState: state }).where(eq(diceFlushRooms.id, roomId));
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
