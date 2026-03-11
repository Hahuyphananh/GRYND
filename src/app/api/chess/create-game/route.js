// src/app/api/chess/create-game/route.js
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { eq, and, isNull, ne, lt, or } from "drizzle-orm";
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

      const result = await db
        .update(chessGames)
        .set({
          playerBlackId: clerkId,
          status: "in_progress",
        })
        .where(and(eq(chessGames.id, game.id), isNull(chessGames.playerBlackId)))
        .returning({ id: chessGames.id });

      if (result.length > 0) {
        return NextResponse.json({
          gameId: game.id,
          color: "black",
          ready: true,
          status: "in_progress",
        });
      }
    }

    const [newGame] = await db
      .insert(chessGames)
      .values({
        playerWhiteId: clerkId,
        betAmount: tableAmount,
        status: "waiting",
      })
      .returning({ id: chessGames.id });

    return NextResponse.json({
      gameId: newGame.id,
      color: "white",
      ready: false,
      status: "waiting",
    });
  } catch (err) {
    console.error("Create-game error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
