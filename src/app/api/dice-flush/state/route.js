import { NextResponse } from "next/server";
import { asc, db, eq, diceFlushRooms } from "../_lib";

export async function GET(req) {
  const roomId = req.nextUrl.searchParams.get("roomId");
  if (roomId) {
    const [room] = await db.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId)).limit(1);
    return NextResponse.json({ success: true, room: room || null });
  }
  const rooms = await db.select({ id: diceFlushRooms.id, status: diceFlushRooms.status, wager: diceFlushRooms.wager, pot: diceFlushRooms.pot, createdAt: diceFlushRooms.createdAt }).from(diceFlushRooms).where(eq(diceFlushRooms.status, "waiting")).orderBy(asc(diceFlushRooms.createdAt));
  return NextResponse.json({ success: true, rooms });
}
