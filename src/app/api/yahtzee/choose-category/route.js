import { NextResponse } from "next/server";
import { calculateScore } from "../../../../../game-engine/yahtzeeEngine";
import { appendAction, db, eq, loadRoom, nextTurn, requireUser, settleIfEnded, validateMove, yahtzeeRooms } from "../_lib";

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

      // Check if AI is next — let the client handle it via /api/yahtzee/ai-turn
      const aiNext = state.players.some(p => p.isAI && p.userId === state.currentTurn) && state.state === "playing";

      const endedResult = await settleIfEnded(tx, room, state);
      if (!endedResult.ended) {
        await tx.update(yahtzeeRooms).set({ gameState: state }).where(eq(yahtzeeRooms.id, roomId));
      }
      return { ...endedResult, aiNext, state: endedResult.ended ? endedResult.state : state };
    });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
