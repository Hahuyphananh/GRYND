import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { coinFlipGames, users } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { betAmount, choice } = await req.json();
  if (!["heads", "tails"].includes(choice)) {
    return NextResponse.json({ error: "Invalid choice" }, { status: 400 });
  }

  // Deduct bet from creator
  const [creator] = await db
    .update(users)
    .set({ balance: sql`${users.balance} - ${betAmount}` })
    .where(eq(users.clerkId, userId))
    .returning();

  if (!creator) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (creator.balance < 0) {
    return NextResponse.json({ error: "Insufficient balance" }, { status: 400 });
  }

  const [newGame] = await db
    .insert(coinFlipGames)
    .values({
      player1Id: userId,
      betAmount,
      player1Choice: choice,
    })
    .returning();

  return NextResponse.json({
    success: true,
    data: {
      gameId: newGame.id,
      betAmount: newGame.betAmount,
      player1Choice: newGame.player1Choice,
    },
  });
}
