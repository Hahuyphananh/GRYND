import { NextResponse } from "next/server";
import { db, getDisplayName, initialState, requireUser, diceFlushPlayers, diceFlushRooms } from "../_lib";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";
import { normalizeStake } from "../../../../lib/games/stakes";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = await requireUser();
    const { wager } = await req.json();
    // Creating a room is free — it is a lobby until an opponent takes the
    // second seat, and only then are BOTH stakes taken (see /join). The
    // requested wager is recorded so that join knows what to escrow.
    const amount = normalizeStake(wager, "dice-flush");

    const result = await db.transaction(async (tx) => {
      // Nothing is charged here: the room is a lobby until an opponent takes
      // the second seat, and /join escrows BOTH stakes at that moment.
      const roomId = `yahtzee:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
      const name = await getDisplayName(userId, tx);
      const state = initialState(roomId, userId, name, amount);
      await tx.insert(diceFlushRooms).values({ id: roomId, status: "waiting", wager: amount, pot: amount, gameState: state });
      await tx.insert(diceFlushPlayers).values({ roomId, userId, isAi: false, score: 0 });
      return { roomId, state };
    });

    return NextResponse.json({ success: true, roomId: result.roomId, viewerId: userId, state: result.state });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed to create room" }, { status: 400 });
  }
}
