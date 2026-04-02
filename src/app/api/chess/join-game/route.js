import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

async function getUserAliases(clerkId) {
  const aliases = new Set([String(clerkId)]);
  const [userRow] = await db.select({ id: users.id }).from(users).where(eq(users.clerkId, clerkId)).limit(1);
  if (userRow?.id) aliases.add(String(userRow.id));
  return aliases;
}

export async function POST(req) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { gameId } = await req.json();
  const parsedGameId = Number(gameId);

  if (!Number.isFinite(parsedGameId) || parsedGameId <= 0) {
    return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
  }

  try {
    const userAliases = await getUserAliases(userId);

    const result = await db.transaction(async (tx) => {
      const [game] = await tx
        .select()
        .from(chessGames)
        .where(
          and(
            eq(chessGames.id, parsedGameId),
            eq(chessGames.status, "waiting"),
            isNull(chessGames.playerBlackId),
            eq(chessGames.isAiGame, false)
          )
        )
        .for("update");

      if (!game) {
        throw new Error("Game is no longer available");
      }
      if (userAliases.has(String(game.playerWhiteId))) {
        throw new Error("You cannot join your own game");
      }

      const [updatedUser] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${game.betAmount}` })
        .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${game.betAmount}`))
        .returning({ balance: users.balance });

      if (!updatedUser) {
        throw new Error("Insufficient balance");
      }

      const [updatedGame] = await tx
        .update(chessGames)
        .set({
          playerBlackId: userId,
          status: "in_progress",
          startedAt: new Date(),
        })
        .where(and(eq(chessGames.id, parsedGameId), isNull(chessGames.playerBlackId)))
        .returning({ id: chessGames.id, playerWhiteId: chessGames.playerWhiteId, playerBlackId: chessGames.playerBlackId });

      if (!updatedGame) {
        throw new Error("Game is no longer available");
      }

      return {
        gameId: updatedGame.id,
        playerWhiteId: updatedGame.playerWhiteId,
        playerBlackId: updatedGame.playerBlackId,
        newBalance: Number(updatedUser.balance),
      };
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error("chess join-game failed", {
      gameId: parsedGameId,
      requester: userId,
      message: error?.message,
      stack: error?.stack,
    });
    return NextResponse.json({ success: false, error: error.message || "Failed to join game" }, { status: 400 });
  }
}
