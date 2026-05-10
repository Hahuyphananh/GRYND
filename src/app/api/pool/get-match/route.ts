import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { poolMatches, poolLobbies } from "../../../../db/schema";
<<<<<<< HEAD
import { desc } from "drizzle-orm";
=======
import { auth } from "@clerk/nextjs/server";
>>>>>>> e08e4fbc53cc0cc29b084d6bcb35dd4344f03360

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
  if (!lobby) return NextResponse.json({ ok: true, match: null });

  if (lobby.status === "active") {
    const [linkedMatch] = await db
      .select()
      .from(poolMatches)
      .where(eq(poolMatches.lobbyId, lobby.id))
      .orderBy(desc(poolMatches.createdAt))
      .limit(1);

    if (linkedMatch) return NextResponse.json({ ok: true, match: linkedMatch });
  }

  return NextResponse.json({ ok: true, match: { id: lobby.id, status: lobby.status } });
}
