import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { diceMatches, diceTurns, users } from "../../../../db/schema";
import { desc, eq, or } from "drizzle-orm";

export async function GET(req: Request) {
  const { userId } = await auth();

  const { searchParams } = new URL(req.url);
  const matchId = searchParams.get("matchId");

  if (!matchId) return NextResponse.json({ ok: false }, { status: 400 });

  const [match] = await db
    .select()
    .from(diceMatches)
    .where(or(eq(diceMatches.id, matchId), eq(diceMatches.lobbyId, matchId)))
    .limit(1);

  if (!match) return NextResponse.json({ ok: false }, { status: 404 });

  // 👇 FETCH USERS
  const [player1] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, match.player1Id))
    .limit(1);

  const [player2] = await db
    .select()
    .from(users)
    .where(eq(users.clerkId, match.player2Id))
    .limit(1);

  const turns = await db
    .select()
    .from(diceTurns)
    .where(eq(diceTurns.matchId, matchId))
    .orderBy(desc(diceTurns.createdAt))
    .limit(10);

  return NextResponse.json({
    ok: true,
    match: {
      ...match,

      // 👇 ADD NAMES HERE
      player1Name: player1?.name || "Player 1",
      player2Name: player2?.name || "Player 2",
    },
    turns,
    viewerId: userId,
  });
}
