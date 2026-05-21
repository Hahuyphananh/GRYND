import { NextResponse } from "next/server";
import { asc, db, eq, yahtzeeRooms } from "../_lib";

export async function GET(req) {
  const roomId = req.nextUrl.searchParams.get("roomId");
  if (roomId) {
    const [room] = await db.select().from(yahtzeeRooms).where(eq(yahtzeeRooms.id, roomId)).limit(1);
    return NextResponse.json({ success: true, room: room || null });
  }
  const rooms = await db.select({ id: yahtzeeRooms.id, status: yahtzeeRooms.status, wager: yahtzeeRooms.wager, pot: yahtzeeRooms.pot, createdAt: yahtzeeRooms.createdAt }).from(yahtzeeRooms).where(eq(yahtzeeRooms.status, "waiting")).orderBy(asc(yahtzeeRooms.createdAt));
  return NextResponse.json({ success: true, rooms });
}
