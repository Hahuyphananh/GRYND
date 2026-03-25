// src/app/api/chess/create-game/route.js
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { eq, and, lt, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const tableAmount = Number(body.tableAmount);
    if (!tableAmount || tableAmount <= 0) {
      return NextResponse.json({ error: "Invalid stake amount" }, { status: 400 });
    }

    await db
      .update(chessGames)
      .set({ status: "expired" })
      .where(
        and(
          eq(chessGames.status, "waiting"),
          eq(chessGames.isAiGame, false),
          lt(chessGames.createdAt, new Date(Date.now() - 5 * 60 * 1000))
        )
      );

    const existingGame = await db
      .select()
      .from(chessGames)
      .where(
        and(
          or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId)),
          eq(chessGames.isAiGame, false),
          or(eq(chessGames.status, "waiting"), eq(chessGames.status, "in_progress"))
        )
      )
      .orderBy(chessGames.createdAt)
      .limit(1);

    if (existingGame.length > 0) {
      const game = existingGame[0];
      const color = game.playerWhiteId === clerkId ? "white" : "black";
      const ready = Boolean(game.playerWhiteId && game.playerBlackId);

      if (game.status === "waiting" && Number(game.betAmount) !== tableAmount) {
        return NextResponse.json(
          {
            error: `You already have a waiting game at $${Number(game.betAmount)}. Cancel it first or re-open that table.`,
            existingGameId: game.id,
          },
          { status: 400 }
        );
      }

      return NextResponse.json({
        gameId: game.id,
        color,
        ready,
        status: game.status,
        note: "Reusing existing game",
      });
    }

    const createdGame = await db.transaction(async (tx) => {
      const [updatedUser] = await tx
        .update(users)
        .set({ balance: sql`${users.balance} - ${tableAmount}` })
        .where(and(eq(users.clerkId, clerkId), sql`${users.balance} >= ${tableAmount}`))
        .returning({ balance: users.balance });

      if (!updatedUser) {
        throw new Error("Insufficient balance");
      }

      const [newGame] = await tx
        .insert(chessGames)
        .values({
          playerWhiteId: clerkId,
          betAmount: tableAmount,
          status: "waiting",
          isAiGame: false,
        })
        .returning({ id: chessGames.id });

      return { gameId: newGame.id, newBalance: Number(updatedUser.balance) };
    });

    return NextResponse.json({
      gameId: createdGame.gameId,
      color: "white",
      ready: false,
      status: "waiting",
      newBalance: createdGame.newBalance,
    });
  } catch (err) {
    console.error("Create-game error:", err);
    const errorMessage = err?.message || "Internal Server Error";
    const status = errorMessage === "Insufficient balance" ? 400 : 500;
    return NextResponse.json({ error: errorMessage }, { status });
  }
}
