import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../../db/client";
import { rpsPvpGames, users } from "../../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { gameId } = await req.json();
  const parsedGameId = Number(gameId);

  if (!Number.isFinite(parsedGameId)) {
    return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
  }

  try {
    const { game, newBalance } = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(rpsPvpGames)
        .where(
          and(
            eq(rpsPvpGames.id, parsedGameId),
            isNull(rpsPvpGames.player2Id),
            eq(rpsPvpGames.status, "active")
          )
        )
        .for("update");

      if (!game) {
        throw new Error("Game is no longer available");
      }
      if (game.player1Id === userId) {
        throw new Error("Cannot join your own game");
      }

      const [updatedUser] = await tx
        .update(users)
        .set({
          balance: sql`${users.balance} - ${game.betAmount}`,
        })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${game.betAmount}`))
        .returning({ balance: users.balance });

      if (!updatedUser) {
        throw new Error("Insufficient balance");
      }

      const [matchedGame] = await tx
        .update(rpsPvpGames)
        .set({
          player2Id: userId,
          status: "matched",
        })
        .where(eq(rpsPvpGames.id, parsedGameId))
        .returning();

      return { game: matchedGame, newBalance: Number(updatedUser.balance) };
    });

    return NextResponse.json({
      success: true,
      data: {
        gameId: game.id,
        player1Id: game.player1Id,
        player2Id: game.player2Id,
        newBalance,
      },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message || "Failed to join game" }, { status: 400 });
  }
}
