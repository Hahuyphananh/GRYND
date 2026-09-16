import { NextResponse } from "next/server";
import { and, inArray } from "drizzle-orm";
import { asc, db, eq, resolveExpiredTurn, diceFlushRooms } from "../_lib";
import { glows, tokenSubscriptions, users } from "../../../../db/schema";
import { resolvePrestigeBadge } from "../../../../lib/prestige";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../../../../lib/stripe/subscriptions";
import { sql } from "drizzle-orm";


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
      iconKey: users.selectedIcon,
      chatColor: users.chatColor,
      glowColor: glows.color,
      isPremium: sql`(${tokenSubscriptions.status} IS NOT NULL)`,
    })
    .from(users)
    .leftJoin(
      glows,
      and(eq(glows.key, users.selectedGlow), eq(glows.enabled, true)),
    )
    .leftJoin(
      tokenSubscriptions,
      and(
        eq(tokenSubscriptions.clerkId, users.clerkId),
        inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
      ),
    )
    .where(inArray(users.clerkId, humanIds));
  const badgeByUser = new Map();
  const iconByUser = new Map();
  const colorByUser = new Map();
  for (const row of rows) {
    badgeByUser.set(
      String(row.clerkId),
      resolvePrestigeBadge({
        xp: row.xp,
        prestigeLevel: row.prestigeLevel,
        showPrestigeBadge: row.showPrestigeBadge,
      }),
    );
    iconByUser.set(String(row.clerkId), row.iconKey || "default");
    // Equipped name color — battlepass glow wins; the Grynd+ chat
    // color only surfaces for active members (chat-route precedence).
    colorByUser.set(
      String(row.clerkId),
      row.glowColor ||
        (Boolean(row.isPremium) ? row.chatColor || null : null) ||
        null,
    );
  }
  return {
    ...room,
    gameState: {
      ...room.gameState,
      players: players.map((p) =>
        p.isAI
          ? p
          : {
              ...p,
              prestigeBadge: badgeByUser.get(String(p.userId)) || null,
              iconKey: iconByUser.get(String(p.userId)) || "default",
              nameColor: colorByUser.get(String(p.userId)) || null,
            },
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
    // `serverTime` lets the client anchor the shot-clock countdown to the
    // server's clock (same pattern as keno-pvp) instead of trusting the
    // device clock, which may be skewed.
    return NextResponse.json({ success: true, serverTime: Date.now(), room: room ? await enrichRoomPlayers(room) : null });
  }

  const rooms = await db.select({ id: diceFlushRooms.id, status: diceFlushRooms.status, wager: diceFlushRooms.wager, pot: diceFlushRooms.pot, createdAt: diceFlushRooms.createdAt }).from(diceFlushRooms).where(eq(diceFlushRooms.status, "waiting")).orderBy(asc(diceFlushRooms.createdAt));
  return NextResponse.json({ success: true, rooms });
}
