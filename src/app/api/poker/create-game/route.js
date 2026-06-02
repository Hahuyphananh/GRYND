import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { auth } from "@clerk/nextjs/server";

function validateMaxPlayers(value) {
  const maxPlayers = Number(value ?? 6);
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 9) {
    return { error: "Invalid maxPlayers" };
  }
  return { maxPlayers };
}

export async function POST(req) {
  try {
    const { userId: clerkId } = await auth();
    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    const parsed = validateMaxPlayers(body?.maxPlayers);
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const isPrivate = body?.isPrivate ?? true;
    if (typeof isPrivate !== "boolean") {
      return NextResponse.json({ error: "Invalid isPrivate" }, { status: 400 });
    }

    const gameCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    const [newGame] = await db
      .insert(pokerGames)
      .values({
        maxPlayers: parsed.maxPlayers,
        isPrivate,
        gameCode,
        status: "waiting",
        pot: "0",
        round: "pre-flop",
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
    return NextResponse.json({ error: err?.message || "Server error" }, { status: 500 });
  }
}
