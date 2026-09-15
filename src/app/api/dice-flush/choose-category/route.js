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
        return { success: false, error: "Turn expired. Best category auto-banked.", state: resolved.state, status: 409 };
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
      // `settleIfEnded` returns { state, ended, … } with NO `success` field, so
      // the flag has to be set here. Without it the client's
      // `if (!res.ok || !d.success)` check treated every successful
      // "Confirm Play" as a failure and alerted "Failed" — even though the
      // category had already been banked server-side.
      return {
        ...endedResult,
        success: true,
        aiNext,
        state: endedResult.ended ? endedResult.state : state,
      };
    });
    // The expired-turn branch above returns its own { success: false, error,
    // state, status: 409 }; every other path is a success.
    return NextResponse.json(result, { status: result.status ?? 200 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
