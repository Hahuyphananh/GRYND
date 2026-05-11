import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { and, eq, sql } from "drizzle-orm";
import { diceLobbies, diceMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId)
    return NextResponse.json(
      { ok: false, message: "Unauthorized" },
      { status: 401 },
    );
  const { lobbyId } = await req.json();
  const lobby = await db
    .select()
    .from(diceLobbies)
    .where(and(eq(diceLobbies.id, lobbyId), eq(diceLobbies.status, "waiting")))
    .limit(1);
  if (!lobby.length)
    return NextResponse.json(
      { ok: false, message: "Lobby unavailable" },
      { status: 404 },
    );
  const l = lobby[0];
  const isHost = l.hostUserId === userId;

  // ❌ block host from "joining" their own lobby
  if (isHost) {
    return NextResponse.json(
      { ok: false, message: "Host cannot join own lobby" },
      { status: 400 },
    );
  }

  const opponentId = userId;
  if (!l.hostUserId || !opponentId) {
    return NextResponse.json(
      { ok: false, message: "Invalid match state" },
      { status: 400 },
    );
  }
  const updated = await db
    .update(diceLobbies)
    .set({ opponentUserId: opponentId, status: "active" })
    .where(eq(diceLobbies.id, lobbyId))
    .returning();
  let matchId: string | null = null;
  if (opponentId) {
    const turnUserId = Math.random() < 0.5 ? l.hostUserId : opponentId;
    const [m] = await db
      .insert(diceMatches)
      .values({
        lobbyId,
        player1Id: l.hostUserId,
        player2Id: opponentId,
        wager: l.wager,
        houseFee: sql`(${l.wager} * 2 * 2) / 100`,
        prizePaid: 0,
        hp1: 20,
        hp2: 20,
        turnUserId,
        round: 1,
        status: "active",
      })
      .returning({ id: diceMatches.id });
    matchId = m.id;
  }
  return NextResponse.json({ ok: true, lobby: updated[0], matchId });
}
