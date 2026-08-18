import { NextResponse } from "next/server";
import { db, eq, loadRoom, requireUser, diceFlushRooms } from "../_lib";
import { playerTotals } from "../../../../../game-engine/diceFlushEngine";

export async function GET(req) {
  try {
    const userId = await requireUser();
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");
    if (!roomId) throw new Error("Missing roomId");

    const room = await loadRoom(roomId);
    const state = room.gameState;
    if (!state) throw new Error("No game state found");

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
      { success: false, error: e.message || "Failed" },
      { status: 400 }
    );
  }
}
