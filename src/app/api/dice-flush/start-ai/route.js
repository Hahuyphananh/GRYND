import { NextResponse } from "next/server";
import { TURN_TIME_LIMIT_MS } from "../../../../../game-engine/diceFlushEngine";
import { db, getDisplayName, initialState, requireUser, diceFlushPlayers, diceFlushRooms } from "../_lib";

export async function POST(req) {
  try {
    const userId = await requireUser();
    const { wager, difficulty = "medium" } = await req.json();
    const amount = Number(wager);
    if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ success: false, error: "Invalid wager" }, { status: 400 });

    const result = await db.transaction(async (tx) => {
      // AI mode is free play — skip `lockBalance` (no token deduction) and
      // keep `state.pot` at 0 so no payout gets credited on game end either.
      const roomId = `yahtzee:${Date.now()}:ai`;
      const name = await getDisplayName(userId, tx);
      const state = initialState(roomId, userId, name, amount);
      const aiId = `ai:${difficulty}`;
      state.ai = true;
      state.players.push({ userId: aiId, name: `AI (${difficulty})`, isAI: true, difficulty });
      state.state = "playing";
      // Shared sheet: random 50/50 starter. Each side claims exactly 6 of
      // the 12 categories — starter has first pick, other has last pick.
      state.currentTurn = Math.random() < 0.5 ? userId : aiId;
      // Shot clock: stamp the first turn's deadline now that play begins.
      state.turnDeadline = Date.now() + TURN_TIME_LIMIT_MS;
      // Free play: record the requested wager for display, but the pot must
      // remain 0 so `settleIfEnded` does not credit any tokens to either side.
      state.wager = amount;
      state.pot = 0;
      await tx.insert(diceFlushRooms).values({ id: roomId, status: "playing", wager: amount, pot: state.pot, gameState: state });
      await tx.insert(diceFlushPlayers).values([{ roomId, userId, isAi: false, score: 0 }, { roomId, userId: aiId, isAi: true, score: 0 }]);
      return { roomId, state };
    });

    return NextResponse.json({ success: true, roomId: result.roomId, state: result.state });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to create AI room" }, { status: 400 });
  }
}
