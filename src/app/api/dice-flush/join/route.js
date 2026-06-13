import { NextResponse } from "next/server";
import { and, db, eq, getDisplayName, isNull, loadRoom, lockBalance, requireUser, diceFlushPlayers, diceFlushRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { roomId } = await req.json();
    if (!roomId) return NextResponse.json({ success: false, error: "roomId required" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      if (room.status !== "waiting") throw new Error("Room unavailable");
      await lockBalance(tx, userId, room.wager);
      const name = await getDisplayName(userId, tx);
      const state = room.gameState;
      state.players.push({ userId, name });
      state.scorecards[userId] = {};
      state.state = "playing";
      state.pot += room.wager;
      await tx.insert(diceFlushPlayers).values({ roomId, userId, isAi: false, score: 0 });
      await tx.update(diceFlushRooms).set({ status: "playing", pot: state.pot, gameState: state }).where(and(eq(diceFlushRooms.id, roomId), eq(diceFlushRooms.status, "waiting")));
      return state;
    });

    return NextResponse.json({ success: true, state: result });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to join" }, { status: 400 });
  }
}
