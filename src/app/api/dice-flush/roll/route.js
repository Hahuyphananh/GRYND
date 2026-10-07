import { NextResponse } from "next/server";
import { appendAction, assertRoomSeat, db, eq, errorStatus, loadRoom, resolveExpiredTurn, rollDice, validateMove, diceFlushRooms } from "../_lib";
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";

export async function POST(req) {
  try {
    const gate = await requirePracticePlayer();
    if (gate.response) return gate.response;
    const userId = gate.playerId;
    const { roomId } = await req.json();
    const next = await db.transaction(async (tx) => {
      const room = await loadRoom(roomId, tx);
      // Per-room seat check: only a player holding a seat may act on the
      // room (a guest with no seat gets the same 403 a signed-in stranger
      // gets). Runs BEFORE the shot-clock resolution so a non-seat can
      // never mutate the room's state.
      assertRoomSeat(room.gameState, userId);
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
    return NextResponse.json({ success: false, error: e.message || "Failed" }, { status: errorStatus(e) });
  }
}
