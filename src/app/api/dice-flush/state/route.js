import { NextResponse } from "next/server";
import { and, inArray } from "drizzle-orm";
import { asc, db, eq, isRoomSeat, resolveExpiredTurn, diceFlushRooms } from "../_lib";
import { glows, tokenSubscriptions, users } from "../../../../db/schema";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../../../../lib/stripe/subscriptions";
import { getFrameDecorations } from "../../../../lib/cosmetics";
import { sql } from "drizzle-orm";
import { isGuestId } from "../../../../lib/guestIdentity";
// This route is a plain GET that the page middleware does NOT cover (every
// /api/* path is public there), and it can mutate room state via
// resolveExpiredTurn() — which settles a finished match. So the caller is
// verified here: a signed-in player goes through the usual 18+ gate, a
// signed-out visitor is a guest seat. A roomId read additionally requires the
// caller to HOLD A SEAT in that room (per-room owner check), so neither a
// signed-in stranger nor a seatless guest can read or settle another room.
import { requirePracticePlayer } from "../../../../lib/auth/guestSession";


async function enrichRoomPlayers(room) {
  if (!room || !room.gameState) return room;
  const players = Array.isArray(room.gameState.players) ? room.gameState.players : [];
  // Guests own no `users` row, so they are never badge-lookup targets; their
  // seat is decorated locally below (letter badge, no catalog icon).
  const humanIds = players.filter((p) => !p.isAI && p.userId && !isGuestId(p.userId)).map((p) => p.userId);
  if (humanIds.length === 0) return room;
  const rows = await db
    .select({
      clerkId: users.clerkId,
      iconKey: users.selectedIcon,
      equippedCosmetics: users.equippedCosmetics,
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
  const iconByUser = new Map();
  const colorByUser = new Map();
  const frameByUser = new Map();
  const decorations = await getFrameDecorations(
    rows.map((row) => row.equippedCosmetics),
  );
  const decorationByClerkId = new Map(
    rows.map((row, index) => [String(row.clerkId), decorations[index]]),
  );
  for (const row of rows) {
    iconByUser.set(String(row.clerkId), row.iconKey || "default");
    // Equipped name color — an owned glow wins; the GRYND PRO chat
    // color only surfaces for active members (chat-route precedence).
    colorByUser.set(
      String(row.clerkId),
      row.glowColor ||
        (Boolean(row.isPremium) ? row.chatColor || null : null) ||
        null,
    );
    frameByUser.set(String(row.clerkId), decorationByClerkId.get(String(row.clerkId)) || null);
  }
  return {
    ...room,
    gameState: {
      ...room.gameState,
      players: players.map((p) => {
        if (p.isAI) return p;
        // A guest seat: no catalog icon (the avatar layer draws the "G"
        // badge), no frame, no name colour — never the default pfp.
        if (isGuestId(p.userId)) {
          return { ...p, iconKey: null, profileFrame: null, nameColor: null, isGuest: true };
        }
        return {
          ...p,
          iconKey: iconByUser.get(String(p.userId)) || "default",
          profileFrame: frameByUser.get(String(p.userId)) || null,
          nameColor: colorByUser.get(String(p.userId)) || null,
        };
      }),
    },
  };
}

export async function GET(req) {
  const gate = await requirePracticePlayer();
  if (gate.response) return gate.response;
  // The caller's own seat id. Returned to the client so it can tell which
  // seat is its own — a guest has no Clerk session, so `user.id` does not
  // exist client-side.
  const viewerId = gate.playerId;

  const roomId = req.nextUrl.searchParams.get("roomId");
  if (roomId) {
    // Per-room owner check. The resolution below mutates room state (it can
    // settle a finished match), so it MUST only run for a caller holding a
    // seat in THIS room. The check lives inside the transaction so a
    // non-seat request resolves to a 403 without touching the room.
    let forbidden = false;
    await db.transaction(async (tx) => {
      const [room] = await tx.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId)).limit(1);
      if (!room) return;
      if (!isRoomSeat(room.gameState, viewerId)) {
        forbidden = true;
        return;
      }
      // Resolve a stalled turn (shot clock) so a polling client sees the
      // auto-bank even if nobody has made a move since the deadline passed.
      await resolveExpiredTurn(tx, room, room.gameState);
    });
    if (forbidden) {
      return NextResponse.json({ success: false, error: "Not a player in this room" }, { status: 403 });
    }
    const [room] = await db.select().from(diceFlushRooms).where(eq(diceFlushRooms.id, roomId)).limit(1);
    // `serverTime` lets the client anchor the shot-clock countdown to the
    // server's clock (same pattern as keno-pvp) instead of trusting the
    // device clock, which may be skewed.
    return NextResponse.json({ success: true, serverTime: Date.now(), viewerId, room: room ? await enrichRoomPlayers(room) : null });
  }

  const rooms = await db.select({ id: diceFlushRooms.id, status: diceFlushRooms.status, wager: diceFlushRooms.wager, pot: diceFlushRooms.pot, createdAt: diceFlushRooms.createdAt }).from(diceFlushRooms).where(eq(diceFlushRooms.status, "waiting")).orderBy(asc(diceFlushRooms.createdAt));
  return NextResponse.json({ success: true, viewerId, rooms });
}
