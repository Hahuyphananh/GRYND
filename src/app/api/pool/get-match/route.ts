import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { poolMatches, poolLobbies } from "../../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const matchId = searchParams.get("matchId") || "";
  const { userId } = await auth();
  const [match] = await db.select().from(poolMatches).where(eq(poolMatches.id, matchId)).limit(1);
  if (match) {
    const viewerSeat: 1 | 2 = userId && userId === match.player2Id ? 2 : 1;
    return NextResponse.json({ ok: true, match, viewerSeat, viewerName: "You", opponentName: match.player2Id === "AI" ? "AI" : "Opponent" });
  }
  const [lobby] = await db.select().from(poolLobbies).where(eq(poolLobbies.id, matchId)).limit(1);
  return NextResponse.json({ ok: true, match: lobby ? { id: lobby.id, status: lobby.status } : null });
}
