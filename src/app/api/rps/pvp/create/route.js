import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON payload" }, { status: 400 });
    }

    const parsedBet = Number(body?.betAmount);

    if (!Number.isFinite(parsedBet) || parsedBet <= 0) {
      return NextResponse.json({ success: false, error: "Invalid bet amount" }, { status: 400 });
    }

    const { game, newBalance } = await db.transaction(async (tx) => {
      const [updatedUser] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} - ${parsedBet}`,
        })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${parsedBet}`))
        .returning({ balance: users.balance });

      if (!updatedUser) {
        throw new Error("Insufficient balance");
      }

      const [game] = await tx
        .insert(rpsPvpGames)
        .values({
          player1Id: userId,
          betAmount: parsedBet,
          status: "active",
        })
        .returning();

      return { game, newBalance: Number(updatedUser.balance) };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        player1Id: game.player1Id,
        betAmount: Number(game.betAmount),
        newBalance,
      },
    });
  } catch (err) {
    console.error("RPS PvP create error:", err);
    const message = err?.message || "Failed to create game";
    const status = message === "Insufficient balance" ? 400 : 500;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
