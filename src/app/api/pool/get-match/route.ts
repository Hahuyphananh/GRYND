import { NextResponse } from "next/server";
import { db } from "../../../../db";
import { eq } from "drizzle-orm";
import { poolMatches, poolLobbies } from "../../../../db/schema";
import { desc } from "drizzle-orm";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const matchId = searchParams.get("matchId") || "";
  const [match] = await db.select().from(poolMatches).where(eq(poolMatches.id, matchId)).limit(1);
  if (match) return NextResponse.json({ ok: true, match });
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
