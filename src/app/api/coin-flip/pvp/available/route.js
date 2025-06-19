import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { coinFlipGames, users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET() {
  const games = await db
    .select({
      id: coinFlipGames.id,
      betAmount: coinFlipGames.betAmount,
      player1Id: coinFlipGames.player1Id,
    })
    .from(coinFlipGames)
    .where(eq(coinFlipGames.player2Id, null))
    .limit(20);

  return NextResponse.json({ success: true, data: { games } });
}
