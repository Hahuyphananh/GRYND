import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export async function POST(req) {
  try {
    const body = await req.json();
    const maxPlayers = body.maxPlayers ?? 6;
    const isPrivate = body.isPrivate ?? true;

    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // Explicitly seed an empty 6-seat grid so the /sit route can find a seat
    // regardless of whether the schema-level default JSON applies. Without
    // this, sit requests fail with "Invalid seat" before the host can ever
    // occupy one.
    const emptySeats = Array.from({ length: 6 }, (_, i) => ({
      seat: i,
      clerkId: null,
    }));

    const [newGame] = await db
      .insert(pokerGames)
      .values({
        maxPlayers,
        isPrivate,
        gameCode,
        status: "waiting",
        pot: "0",
        round: "pre-flop",
        players: emptySeats,
        communityCards: [],
        deck: [],
        discardPile: [],
        playerPositions: { hostClerkId: clerkId, state: null },
      })
      .returning();

    return NextResponse.json({
      success: true,
      game: newGame,
      gameCode: newGame.gameCode,
      hostClerkId: clerkId,
    });
  } catch (err) {
    console.error("CREATE GAME ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
