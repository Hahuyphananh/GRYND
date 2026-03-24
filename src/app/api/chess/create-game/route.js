// src/app/api/chess/create-game/route.js
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames, users } from "../../../../db/schema";
import { eq, and, isNull, ne, lt, or, sql } from "drizzle-orm";
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
          lt(chessGames.createdAt, new Date(Date.now() - 5 * 60 * 1000))
        )
      );

    const existingGame = await db
      .select()
      .from(chessGames)
      .where(
        and(
          eq(chessGames.betAmount, tableAmount),
          or(eq(chessGames.playerWhiteId, clerkId), eq(chessGames.playerBlackId, clerkId)),
          ne(chessGames.status, "expired")
        )
      )
      .orderBy(chessGames.createdAt)
      .limit(1);

    if (existingGame.length > 0) {
      const game = existingGame[0];
      const color = game.playerWhiteId === clerkId ? "white" : "black";
      const ready = Boolean(game.playerWhiteId && game.playerBlackId);

      return NextResponse.json({
        gameId: game.id,
        color,
        ready,
        status: game.status,
        note: "Reusing existing game",
      });
    }

    const openGame = await db
      .select()
      .from(chessGames)
      .where(
        and(
          eq(chessGames.betAmount, tableAmount),
          eq(chessGames.status, "waiting"),
          isNull(chessGames.playerBlackId),
          ne(chessGames.playerWhiteId, clerkId)
        )
      )
      .orderBy(chessGames.createdAt)
      .limit(1);

    if (openGame.length > 0) {
      const game = openGame[0];

      const joinResult = await db.transaction(async (tx) => {
        const [gameLocked] = await tx
          .select()
          .from(chessGames)
          .where(and(eq(chessGames.id, game.id), isNull(chessGames.playerBlackId)))
          .for("update");

        if (!gameLocked) {
          throw new Error("Game is no longer available");
        }

        const [updatedUser] = await tx
          .update(users)
          .set({ balance: sql`${users.balance} - ${gameLocked.betAmount}` })
          .where(and(eq(users.clerkId, clerkId), sql`${users.balance} >= ${gameLocked.betAmount}`))
          .returning({ balance: users.balance });

        if (!updatedUser) {
          throw new Error("Insufficient balance");
        }

        const [updatedGame] = await tx
          .update(chessGames)
          .set({
            playerBlackId: clerkId,
            status: "in_progress",
          })
          .where(and(eq(chessGames.id, game.id), isNull(chessGames.playerBlackId)))
          .returning({ id: chessGames.id });

        if (!updatedGame) {
          throw new Error("Game is no longer available");
        }

        return { gameId: updatedGame.id, newBalance: Number(updatedUser.balance) };
      });

      return NextResponse.json({
        gameId: joinResult.gameId,
        color: "black",
        ready: true,
        status: "in_progress",
        newBalance: joinResult.newBalance,
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
    const status = errorMessage === "Insufficient balance" || errorMessage.includes("available") ? 400 : 500;
    return NextResponse.json({ error: errorMessage }, { status });
  }
}
