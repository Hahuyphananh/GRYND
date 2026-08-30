import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  const { betAmount } = await req.json();
  const parsedBet = Number(betAmount);

  if (!Number.isFinite(parsedBet) || parsedBet <= 0) {
    return NextResponse.json(
      { success: false, error: "Invalid bet amount" },
      { status: 400 },
    );
  }
  // Global bet cap (must match GLOBAL_MAX_BET in src/lib/games/economy.ts).
  if (parsedBet > 100000) {
    return NextResponse.json(
      { success: false, error: "Bet exceeds the maximum of 100,000 tokens" },
      { status: 400 },
    );
  }

  try {
    const { game, newBalance } = await db.transaction(async (tx) => {
      const [updatedUser] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} - ${parsedBet}`,
        })
        .where(
          and(eq(users.clerkId, userId), sql`${users.balance} >= ${parsedBet}`),
        )
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
    return NextResponse.json(
      { success: false, error: err.message || "Failed to create game" },
      { status: 400 },
    );
  }
}
