import { NextResponse } from "next/server";
import { TURN_TIME_LIMIT_MS } from "../../../../../game-engine/diceFlushEngine";
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
      const creatorId = state.players[0].userId;
      state.players.push({ userId, name });
      state.state = "playing";
      // Shared sheet: random 50/50 starter. The starter claims turns
      // 1,3,5,7,9,11 and the other player 2,4,6,8,10,12 — each gets exactly
      // 6 of the 12 categories. Starter has first pick; second has last pick.
      state.currentTurn = Math.random() < 0.5 ? creatorId : userId;
      // Shot clock: stamp the first turn's deadline now that play begins.
      state.turnDeadline = Date.now() + TURN_TIME_LIMIT_MS;
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
