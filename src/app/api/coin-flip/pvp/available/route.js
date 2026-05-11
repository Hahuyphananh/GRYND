import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";

export async function GET() {
  const games = await db
    .select({
      id: coinFlipGames.id,
      betAmount: coinFlipGames.betAmount,
      player1Id: coinFlipGames.player1Id,
      player1Name: users.name,
    })
    .from(coinFlipGames)
    .leftJoin(users, eq(users.clerkId, coinFlipGames.player1Id))
    .where(
      and(isNull(coinFlipGames.player2Id), eq(coinFlipGames.status, "active")),
    )
    .limit(20);

  return NextResponse.json({ success: true, data: { games } });
}
