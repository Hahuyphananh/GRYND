import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";

export async function GET() {
  const games = await db
    .select({
      id: rpsPvpGames.id,
      betAmount: rpsPvpGames.betAmount,
      player1Id: rpsPvpGames.player1Id,
      player1Name: users.name,
      createdAt: rpsPvpGames.createdAt,
    })
    .from(rpsPvpGames)
    .leftJoin(users, eq(users.clerkId, rpsPvpGames.player1Id))
    .where(and(isNull(rpsPvpGames.player2Id), eq(rpsPvpGames.status, "active")))
    .limit(30);

  return NextResponse.json({ success: true, data: { games } });
}
