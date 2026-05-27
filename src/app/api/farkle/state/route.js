import { NextResponse } from "next/server";
import { asc, db, eq, farkleRooms } from "../_lib";

export async function GET(req) {
  const roomId = req.nextUrl.searchParams.get("roomId");
  if (roomId) {
    const [room] = await db
      .select()
      .from(farkleRooms)
      .where(eq(farkleRooms.id, roomId))
      .limit(1);
    return NextResponse.json({ success: true, room: room || null });
  }
  const rooms = await db
    .select({
      id: farkleRooms.id,
      status: farkleRooms.status,
      wager: farkleRooms.wager,
      pot: farkleRooms.pot,
      createdAt: farkleRooms.createdAt,
    })
    .from(farkleRooms)
    .where(eq(farkleRooms.status, "waiting"))
    .orderBy(asc(farkleRooms.createdAt));
  return NextResponse.json({ success: true, rooms });
}
