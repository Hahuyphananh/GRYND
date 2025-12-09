import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { auth } from "@clerk/nextjs/server";
import { sql } from "drizzle-orm";

export async function POST(req) {
  try {
    const body = await req.json();
    const maxPlayers = body.maxPlayers ?? 5;
    const isPrivate = body.isPrivate ?? true;

    // 🔥 ALWAYS get host Clerk ID from Clerk server-side
    const { userId: clerkId } = await auth();

    const playerName = body.playerName ?? "Player";

    // 1️⃣ Generate game code
    const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // 2️⃣ Insert game into DB
    const [newGame] = await db
      .insert(pokerGames)
      .values({
        maxPlayers,
        isPrivate,
        gameCode,
        pot: "0",
        round: "preflop",
        communityCards: [],
        deck: [],
        discardPile: [],

        // 🔥 FIX: Serialize player array only if PUBLIC
        players: isPrivate
          ? undefined
          : sql`${JSON.stringify([
              { seat: 0, clerkId: clerkId ?? null }, // host seat
              { seat: 1, clerkId: null },
              { seat: 2, clerkId: null },
              { seat: 3, clerkId: null },
              { seat: 4, clerkId: null },
              { seat: 5, clerkId: null },
            ])}::jsonb`,
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
