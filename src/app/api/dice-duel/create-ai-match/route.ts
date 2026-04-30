import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { diceMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });
  const { wager = 5 } = await req.json().catch(() => ({}));
  const [row] = await db.insert(diceMatches).values({
    lobbyId: null,
    player1Id: userId,
    player2Id: "AI_BOT",
    wager: Number(wager),
    prizePaid: 0,
    houseFee: Math.floor(Number(wager) * 2 * 0.02),
    hp1: 20,
    hp2: 22,
    turnUserId: Math.random() < 0.45 ? userId : "AI_BOT",
    round: 1,
    status: "active",
  }).returning({ id: diceMatches.id });
  return NextResponse.json({ ok: true, matchId: row.id });
}
