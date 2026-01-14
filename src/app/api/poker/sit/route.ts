import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { gameCode, seatIndex } = await req.json();

    if (!gameCode || seatIndex === undefined) {
      return NextResponse.json(
        { error: "gameCode and seatIndex are required" },
        { status: 400 }
      );
    }

    // Load game by gameCode
    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, gameCode));

    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    const players = game.players as any[];

    // Already seated?
    if (players.some((p) => p.clerkId === userId)) {
      return NextResponse.json(
        { error: "User already seated" },
        { status: 400 }
      );
    }

    const seatObj = players.find((p) => p.seat === seatIndex);
    if (!seatObj) {
      return NextResponse.json({ error: "Invalid seat" }, { status: 400 });
    }

    if (seatObj.clerkId !== null) {
      return NextResponse.json({ error: "Seat already taken" }, { status: 400 });
    }

    const updatedPlayers = players.map((p) =>
      p.seat === seatIndex ? { ...p, clerkId: userId } : p
    );

    const [updatedGame] = await db
      .update(pokerGames)
      .set({ players: updatedPlayers })
      .where(eq(pokerGames.gameCode, gameCode))
      .returning();

    return NextResponse.json({ success: true, game: updatedGame });
  } catch (err) {
    console.error("POKER SIT ERROR:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

