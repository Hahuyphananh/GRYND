import { NextResponse } from "next/server";
import { asc, db, eq, resolveExpiredTurn, diceFlushRooms } from "../_lib";

export async function GET(req) {
  const roomId = req.nextUrl.searchParams.get("roomId");
  if (roomId) {
    // Resolve a stalled turn (shot clock) so a polling client sees the
    // auto-bank even if nobody has made a move since the deadline passed.
    await db.transaction(async (tx) => {
      const [room] = await tx.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId)).limit(1);
      if (room) await resolveExpiredTurn(tx, room, room.gameState);
    });
    const [room] = await db.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId)).limit(1);
    return NextResponse.json({ success: true, room: room || null });
  }
  const rooms = await db.select({ id: diceFlushRooms.id, status: diceFlushRooms.status, wager: diceFlushRooms.wager, pot: diceFlushRooms.pot, createdAt: diceFlushRooms.createdAt }).from(diceFlushRooms).where(eq(diceFlushRooms.status, "waiting")).orderBy(asc(diceFlushRooms.createdAt));
  return NextResponse.json({ success: true, rooms });
}
