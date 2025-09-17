import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function PATCH(req) {
  try {
    const body = await req.json();
    console.log("PATCH body received:", body);

    const { gameCode, playerId, hand } = body;

    // ✅ Allow empty arrays for hand, only reject null/undefined
    if (!gameCode || !playerId || hand == null) {
      console.warn("PATCH validation failed:", { gameCode, playerId, hand });
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

  const [game] = await db
  .select()
  .from(pokerGames)
  .where(eq(pokerGames.gameCode, gameCode));

if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

const players = Array.isArray(game.players) ? game.players : [];

// Merge or add player
const updatedPlayers = players.map(p =>
  p.id === playerId ? { ...p, hand } : p
);

if (!updatedPlayers.find(p => p.id === playerId)) {
  // Append new player if not exists
  updatedPlayers.push({
    id: playerId,
    hand,
    isAI: false,
    stack: 1000,
    hasFolded: false,
    currentBet: 0,
    lastAction: "",
    name: body.name || "Unknown",
    isReady: false,
  });
}

// Save updated array
const [updatedGame] = await db
  .update(pokerGames)
  .set({ players: updatedPlayers })
  .where(eq(pokerGames.gameCode, gameCode))
  .returning();


    console.log("PATCH update success:", updatedGame);

    return NextResponse.json({ success: true, game: updatedGame });
  } catch (err) {
    console.error("UPDATE HAND ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
