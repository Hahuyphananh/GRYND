import { NextResponse } from "next/server";
import { assertRoomSeat, db, eq, errorStatus, loadRoom, diceFlushRooms } from "../_lib";
import { playerTotals } from "../../../../../game-engine/diceFlushEngine";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";

export async function GET(req) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");
    if (!roomId) throw new Error("Missing roomId");

    const room = await loadRoom(roomId);
    const state = room.gameState;
    if (!state) throw new Error("No game state found");
    // Per-room owner check — a room's scorecard is only visible to its seats.
    assertRoomSeat(state, userId);

    // Shared sheet: totals are computed per player from the categories each
    // one claimed (see playerTotals in the engine).
    const totals = playerTotals(state);
    const playerTotalsList = (state.players || []).map((p) => ({
      userId: p.userId,
      name: p.name,
      isAI: p.isAI || false,
      ...(totals[p.userId] || { upper: 0, bonus: 0, raw: 0, total: 0 }),
    }));

    return NextResponse.json({ success: true, playerTotals: playerTotalsList });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e.message || "Failed"    }, { status: errorStatus(e) }
  );
}

}
