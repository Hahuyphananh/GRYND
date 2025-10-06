// src/app/api/chess/create-game/route.js
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { chessGames } from "../../../../db/schema";
import { eq, and, isNull } from "drizzle-orm";
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

    // 🔎 Look for open game with same stake
    const openGame = await db
      .select()
      .from(chessGames)
      .where(and(eq(chessGames.betAmount, tableAmount), isNull(chessGames.playerBlackId)))
      .limit(1);

    if (openGame.length > 0) {
      const game = openGame[0];

      // ✅ Join as black
      await db
        .update(chessGames)
        .set({ playerBlackId: clerkId }) // store Clerk ID or map it to your users table
        .where(eq(chessGames.id, game.id));

      return NextResponse.json({ gameId: game.id, color: "black", ready: true });
    } else {
      // ✅ Create new game as white
      const [newGame] = await db
        .insert(chessGames)
        .values({
          playerWhiteId: clerkId,
          betAmount: tableAmount,
        })
        .returning({ id: chessGames.id });

      return NextResponse.json({ gameId: newGame.id, color: "white", ready: false });
    }
  } catch (err) {
    console.error("Create-game error:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
