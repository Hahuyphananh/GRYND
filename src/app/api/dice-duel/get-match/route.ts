import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { diceMatches, diceTurns } from "../../../../db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET(req: Request) {
  const { userId } = await auth();
  const { searchParams } = new URL(req.url);
  const matchId = searchParams.get("matchId");
  if (!matchId) return NextResponse.json({ ok: false }, { status: 400 });
  const [match] = await db.select().from(diceMatches).where(eq(diceMatches.id, matchId)).limit(1);
  if (!match) return NextResponse.json({ ok: false }, { status: 404 });
  const turns = await db.select().from(diceTurns).where(eq(diceTurns.matchId, matchId)).orderBy(desc(diceTurns.createdAt)).limit(10);
  return NextResponse.json({ ok: true, match, turns, viewerId: userId });
}
