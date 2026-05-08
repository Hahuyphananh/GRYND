import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { poolMatches } from "../../../../db/schema";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });
  const { wager = 10 } = await req.json().catch(() => ({}));
  const [m] = await db.insert(poolMatches).values({ player1Id: userId, player2Id: "AI", wager: Number(wager), status: "active", gameState: { ai: true, started: true } }).returning({ id: poolMatches.id });
  return NextResponse.json({ ok: true, matchId: m.id });
}
