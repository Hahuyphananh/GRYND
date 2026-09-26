import { NextResponse } from "next/server";
import { db, getDisplayName, initialState, lockBalance, requireUser, diceFlushPlayers, diceFlushRooms } from "../_lib";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = await requireUser();
    const { wager } = await req.json();
    // STAKES ARE RETIRED (src/lib/games/stakes.js): creating a room is free.
    // The requested wager is normalized to 0, so the lockBalance debit below
    // is a no-op and the pot settles to nothing.
    const amount = normalizeStake(wager);

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
