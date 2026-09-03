import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { asc, db, eq, resolveExpiredTurn, diceFlushRooms } from "../_lib";import { users } from "../../../../db/schema";
import { resolvePrestigeBadge } from "../../../../lib/prestige";


async function enrichRoomPlayers(room) {
  if (!room || !room.gameState) return room;
  const players = Array.isArray(room.gameState.players) ? room.gameState.players : [];
  const humanIds = players.filter((p) => !p.isAI && p.userId).map((p) => p.userId);
  if (humanIds.length === 0) return room;
  const rows = await db
    .select({
      clerkId: users.clerkId,
      xp: users.xp,
      prestigeLevel: users.prestigeLevel,
      showPrestigeBadge: users.showPrestigeBadge,
    })
    .from(users)
    .where(inArray(users.clerkId, humanIds));
  const badgeByUser = new Map();
  for (const row of rows) {
    badgeByUser.set(
      String(row.clerkId),
      resolvePrestigeBadge({
        xp: row.xp,
        prestigeLevel: row.prestigeLevel,
        showPrestigeBadge: row.showPrestigeBadge,
      }),
    );
  }
  return {
    ...room,
    gameState: {
      ...room.gameState,
      players: players.map((p) =>
        p.isAI
          ? p
          : { ...p, prestigeBadge: badgeByUser.get(String(p.userId)) || null },
      ),
    },
  };
}

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
    return NextResponse.json({ success: true, room: room ? await enrichRoomPlayers(room) : null });
  }

  const rooms = await db.select({ id: diceFlushRooms.id, status: diceFlushRooms.status, wager: diceFlushRooms.wager, pot: diceFlushRooms.pot, createdAt: diceFlushRooms.createdAt }).from(diceFlushRooms).where(eq(diceFlushRooms.status, "waiting")).orderBy(asc(diceFlushRooms.createdAt));
  return NextResponse.json({ success: true, rooms });
}
