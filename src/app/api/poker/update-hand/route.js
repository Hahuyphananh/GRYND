import { NextResponse } from "next/server";
import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { sanitizeString } from "../../../../lib/security/validation";

export async function PATCH(req) {
  try {
    const body = await req.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const allowed = ["gameCode", "playerId", "hand", "name"];
    const unexpected = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unexpected.length) {
      return NextResponse.json({ error: `Unexpected field(s): ${unexpected.join(", ")}` }, { status: 400 });
    }

    const gameCode = sanitizeString(body.gameCode || "");
    const playerId = sanitizeString(body.playerId || "");
    const name = sanitizeString(body.name || "Unknown").slice(0, 80) || "Unknown";
    const hand = Array.isArray(body.hand) ? body.hand : null;

    if (!gameCode || !playerId || hand == null) {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }

    const [game] = await db
      .select()
      .from(pokerGames)
      .where(eq(pokerGames.gameCode, gameCode));

    if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const players = Array.isArray(game.players) ? game.players : [];

    const updatedPlayers = players.map((p) =>
      p.id === playerId ? { ...p, hand } : p
    );

    if (!updatedPlayers.find((p) => p.id === playerId)) {
      updatedPlayers.push({
        id: playerId,
        hand,
        isAI: false,
        stack: 1000,
        hasFolded: false,
        currentBet: 0,
        lastAction: "",
        name,
        isReady: false,
      });
    }

    const [updatedGame] = await db
      .update(pokerGames)
      .set({ players: updatedPlayers })
      .where(eq(pokerGames.gameCode, gameCode))
      .returning();

    return NextResponse.json({ success: true, game: updatedGame });
  } catch (err) {
    console.error("UPDATE HAND ERROR", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
