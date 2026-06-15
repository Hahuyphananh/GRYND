import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    // Accept both betAmount and tableAmount for compatibility
    const betAmount = Number(body.betAmount || body.tableAmount) || 0;

    if (!betAmount || betAmount <= 0) {
      return NextResponse.json(
        { error: "Invalid bet amount" },
        { status: 400 },
      );
    }

    // Deduct balance atomically with game creation
    const createdGame = await db.transaction(async (tx) => {
      const [updatedUser] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${betAmount}` })
        .where(
          and(
            eq(users.clerkId, userId),
            sql`${users.balance} >= ${betAmount}`,
          ),
        )
        .returning({ balance: users.balance });

      if (!updatedUser) {
        throw new Error("Insufficient balance");
      }

      const [newGame] = await tx
        .insert(chessGames)
        .values({
          playerWhiteId: userId,
          playerBlackId: null,
          betAmount,
          timerMode: "blitz",
          initialTimeSeconds: 300,
          isAiGame: true,
          status: "in_progress",
        })
        .returning({ id: chessGames.id });

      return { gameId: newGame.id, newBalance: Number(updatedUser.balance) };
    });

    return NextResponse.json({
      gameId: createdGame.gameId,
      newBalance: createdGame.newBalance,
    });
  } catch (err) {
    console.error("Create-AI-game error:", err);
    const errorMessage = err?.message || "Internal Server Error";
    const status = errorMessage === "Insufficient balance" ? 400 : 500;
    return NextResponse.json({ error: errorMessage }, { status });
  }
}
