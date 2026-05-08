import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { and, eq } from "drizzle-orm";
import { poolLobbies, poolMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    const { lobbyId } = await req.json();
    const [lobby] = await db.select().from(poolLobbies).where(and(eq(poolLobbies.id, lobbyId), eq(poolLobbies.status, "waiting"))).limit(1);
    if (!lobby || lobby.hostUserId === userId) return NextResponse.json({ ok: false, message: "Lobby unavailable" }, { status: 400 });
    await db.update(poolLobbies).set({ status: "active", opponentUserId: userId }).where(eq(poolLobbies.id, lobbyId));
    const [m] = await db.insert(poolMatches).values({ id: crypto.randomUUID(), lobbyId, player1Id: lobby.hostUserId, player2Id: userId, wager: lobby.wager, status: "active", gameState: { started: true }, currentTurnUserId: lobby.hostUserId }).returning({ id: poolMatches.id });
    return NextResponse.json({ ok: true, matchId: m.id });
  } catch (error: any) {
    return NextResponse.json({ ok: false, message: error?.message || "Unable to join lobby" }, { status: 500 });
  }
}
