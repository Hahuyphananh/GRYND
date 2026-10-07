import { NextResponse } from "next/server";
import { and, assertRoomSeat, db, eq, errorStatus, loadRoom, diceFlushRooms } from "../_lib";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";

export async function POST(req) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    const { roomId } = await req.json();
    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      const state = room.gameState;
      assertRoomSeat(state, userId);
      if (state.state === "finished") return { state };
      const winner = state.players.find((p) => p.userId !== userId);
      if (!winner) throw new Error("Cannot resign before opponent joins");
      // STAKES ARE RETIRED: there is no pot to pay out on a resignation.
      const payout = 0;
      state.state = "finished";
      state.currentTurn = winner.userId;
      await tx.update(diceFlushRooms).set({ status: "finished", pot: 0, gameState: state }).where(and(eq(diceFlushRooms.id, roomId), eq(diceFlushRooms.status, room.status)));
      return { state, winnerId: winner.userId, payout };
    });
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to resign" }, { status: errorStatus(e) });
  }
}
