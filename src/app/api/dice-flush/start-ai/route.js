import { NextResponse } from "next/server";
import { db, getDisplayName, initialState, lockBalance, requireUser, diceFlushPlayers, diceFlushRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { wager, difficulty = "medium" } = await req.json();
    const amount = Number(wager);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ success: false, error: "Invalid wager" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      await lockBalance(tx, userId, amount);
      const roomId = `yahtzee:${Date.now()}:ai`;
      const name = await getDisplayName(userId, tx);
      const state = initialState(roomId, userId, name, amount);
      const aiId = `ai:${difficulty}`;
      state.ai = true;
      state.players.push({ userId: aiId, name: `AI (${difficulty})`, isAI: true, difficulty });
      state.scorecards[aiId] = {};
      state.state = "playing";
      state.pot = amount * 2;
      await tx.insert(diceFlushRooms).values({ id: roomId, status: "playing", wager: amount, pot: state.pot, gameState: state });
      await tx.insert(diceFlushPlayers).values([{ roomId, userId, isAi: false, score: 0 }, { roomId, userId: aiId, isAi: true, score: 0 }]);
      return { roomId, state };
    });

    return NextResponse.json({ success: true, roomId: result.roomId, state: result.state });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to create AI room" }, { status: 400 });
  }
}
