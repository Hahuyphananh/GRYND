import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { gameId } = await req.json();

  const [game] = await db
    .select()
    .from(coinFlipGames)
    .where(and(eq(coinFlipGames.id, gameId), eq(coinFlipGames.player2Id, null)))
    .limit(1);

  if (!game) {
    return NextResponse.json({ error: "Game not found or already joined" }, { status: 404 });
  }
  if (game.player1Id === userId) {
    return NextResponse.json({ error: "Cannot join your own game" }, { status: 400 });
  }

  // Deduct bet from joining player
  const [joiner] = await db
    .update(users)
    .set({ balance: sql`${users.balance} - ${game.betAmount}` })
    .where(eq(users.clerkId, userId))
    .returning();

  if (joiner.balance < 0) {
    return NextResponse.json({ error: "Insufficient balance" }, { status: 400 });
  }

  await db
    .update(coinFlipGames)
    .set({ player2Id: userId })
    .where(eq(coinFlipGames.id, gameId));

  return NextResponse.json({ success: true, data: { gameId } });
}
