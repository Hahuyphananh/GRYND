import { NextResponse } from "next/server";
import { calculateScore } from "../../../../../game-engine/diceFlushEngine";
import { appendAction, db, eq, loadRoom, nextTurn, requireUser, resolveExpiredTurn, settleIfEnded, validateMove, diceFlushRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId, category } = await req.json();
    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      let state = room.gameState;
      // Shot clock: resolve a stalled turn before processing the move.
      const resolved = await resolveExpiredTurn(tx, room, state);
      if (resolved.didTimeout) {
        return { success: false, error: "Turn expired — best category auto-banked.", state: resolved.state, status: 409 };
      }
      state = resolved.state;
      validateMove(state, userId, "choose_category", { category });
      // Include the score in the player's action payload (call bonus included)
      const playerScore = calculateScore(state.dice, category) + (state.currentCall === category ? 15 : 0);
      const calledCategory = state.currentCall;
      state = nextTurn(state, userId, category);
      await appendAction(tx, roomId, userId, "choose_category", { category, score: playerScore, calledCategory });

      // Check if AI is next — let the client handle it via /api/dice-flush/ai-turn
      const aiNext = state.players.some(p => p.isAI && p.userId === state.currentTurn) && state.state === "playing";

      const endedResult = await settleIfEnded(tx, room, state);
      if (!endedResult.ended) {
        await tx.update(diceFlushRooms).set({ gameState: state }).where(eq(diceFlushRooms.id, roomId));
      }
      return { ...endedResult, aiNext, state: endedResult.ended ? endedResult.state : state };
    });
    // `result` carries its own `success` flag (false + resolved state when the
    // turn expired and was auto-banked; true otherwise).
    return NextResponse.json(result, { status: result.status ?? 200 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
