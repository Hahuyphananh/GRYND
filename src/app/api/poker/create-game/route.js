import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const maxPlayers = body.maxPlayers ?? 6;
    const isPrivate = body.isPrivate ?? true;

    // ✅ Always get host from Clerk
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ✅ Generate game code
    const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // ✅ Create EMPTY game
    const [newGame] = await db
      .insert(pokerGames)
      .values({
        hostClerkId: clerkId,   // ⭐ IMPORTANT
        maxPlayers,
        isPrivate,
        gameCode,

        status: "waiting",      // ⭐ lobby state
        pot: "0",
        round: "preflop",

        communityCards: [],
        deck: [],
        discardPile: [],

        // ❌ NO players here
      })
      .returning();

    return NextResponse.json({
      success: true,
      game: newGame,
      gameCode: newGame.gameCode,
    });
  } catch (err) {
    console.error("CREATE GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
