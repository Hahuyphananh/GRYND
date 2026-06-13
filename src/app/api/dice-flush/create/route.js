import { NextResponse } from "next/server";
import { db, getDisplayName, initialState, lockBalance, requireUser, diceFlushPlayers, diceFlushRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { wager } = await req.json();
    const amount = Number(wager);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ success: false, error: "Invalid wager" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      await lockBalance(tx, userId, amount);
      const roomId = `yahtzee:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
      const name = await getDisplayName(userId, tx);
      const state = initialState(roomId, userId, name, amount);
      await tx.insert(diceFlushRooms).values({ id: roomId, status: "waiting", wager: amount, pot: amount, gameState: state });
      await tx.insert(diceFlushPlayers).values({ roomId, userId, isAi: false, score: 0 });
      return { roomId, state };
    });

    return NextResponse.json({ success: true, roomId: result.roomId, state: result.state });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to create room" }, { status: 400 });
  }
}
