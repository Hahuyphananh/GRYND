import { NextResponse } from "next/server";
import { appendAction, db, eq, loadRoom, requireUser, resolveExpiredTurn, rollDice, validateMove, diceFlushRooms } from "../_lib";
import { requireAgeVerifiedUser } from "../../../../lib/auth/requireAgeVerified";

export async function POST(req) {
  try {
    const gate = await requireAgeVerifiedUser();
    if (gate.response) return gate.response;
    const userId = await requireUser();
    const { roomId } = await req.json();
    const next = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      // Shot clock: resolve a stalled turn before processing the move.
      const resolved = await resolveExpiredTurn(tx, room, room.gameState);
      if (resolved.didTimeout) {
        return { success: false, error: "Turn expired. Best category auto-banked.", state: resolved.state, status: 409 };
      }
      validateMove(resolved.state, userId, "roll_dice");
      const updated = rollDice(resolved.state);
      await tx.update(diceFlushRooms).set({ gameState: updated }).where(eq(diceFlushRooms.id, roomId));
      await appendAction(tx, roomId, userId, "roll_dice", {});
      return { success: true, state: updated };
    });
    return NextResponse.json(next, { status: next.status ?? 200 });
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: 400 });
  }
}
