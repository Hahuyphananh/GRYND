import { NextResponse } from "next/server";
import { calculateScore, checkGameEnd, rollDice } from "../../../../../game-engine/yahtzeeEngine";
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

function processAiTurn(state, tx, roomId) {
  let s = { ...state };
  const aiPlayer = s.players.find(p => p.isAI);
  if (!aiPlayer || s.currentTurn !== aiPlayer.userId) return { state: s, aiRolls: [] };

  // Roll dice and log each roll
  const aiRolls = [];
  for (let i = 0; i < 3; i++) {
    s = rollDice(s);
    aiRolls.push({ dice: [...s.dice], rollsThisTurn: s.rollsThisTurn });
    if (tx) appendAction(tx, roomId, aiPlayer.userId, "roll", {});
  }

  const category = pickAiCategory(s);
  const score = calculateScore(s.dice, category);
  s = nextTurn(s, aiPlayer.userId, category);

  // Log AI's category choice with score
  if (tx) appendAction(tx, roomId, aiPlayer.userId, "choose_category", { category, score });

  return { state: s, aiRolls, aiCategory: category, aiScore: score };
}

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, category } = await req.json();
    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      let state = room.gameState;
      validateMove(state, userId, "choose_category", { category });
      // Include the score in the player's action payload
      const playerScore = calculateScore(state.dice, category);
      state = nextTurn(state, userId, category);
      await appendAction(tx, roomId, userId, "choose_category", { category, score: playerScore });

      // Process AI turns with visual step data (dice rolls + category highlight)
      let aiProcessed = false;
      const allAiRolls = [];
      let aiCategory = null;
      let aiScore = null;
      while (state.players.some(p => p.isAI && p.userId === state.currentTurn) && state.state === "playing") {
        const result = processAiTurn(state, tx, roomId);
        state = result.state;
        if (result.aiRolls.length > 0) {
          allAiRolls.push(...result.aiRolls);
          aiCategory = result.aiCategory;
          aiScore = result.aiScore;
        }
        aiProcessed = true;
      }

      const endedResult = await settleIfEnded(tx, room, state);
      if (!endedResult.ended) {
        await tx.update(yahtzeeRooms).set({ gameState: state }).where(eq(yahtzeeRooms.id, roomId));
      }
      return { ...endedResult, aiProcessed, aiRolls: allAiRolls.length > 0 ? allAiRolls : undefined, aiCategory, aiScore };
    });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
