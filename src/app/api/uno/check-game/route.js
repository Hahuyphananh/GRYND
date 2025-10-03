// /api/uno/check-game/route.js
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { unoGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 });
  }

  const { gameId } = await request.json();
  if (!gameId) {
    return new Response(JSON.stringify({ success: false, error: "Missing gameId" }), { status: 400 });
  }

  try {
    const game = await db.query.unoGames.findFirst({ where: eq(unoGames.id, gameId) });
    if (!game) {
      return new Response(JSON.stringify({ success: false, error: "Game not found" }), { status: 404 });
    }

    // if still waiting → return waiting
    if (game.status === "waiting") {
      return new Response(JSON.stringify({
        success: true,
        status: "waiting"
      }), { status: 200 });
    }

    // if active → return game details
    if (game.status === "active") {
      return new Response(JSON.stringify({
        success: true,
        status: "active",
        data: {
          id: game.id,
          topCard: JSON.parse(game.topCard),
          currentColor: game.currentColor,
          turn: game.turn,
          player1Hand: JSON.parse(game.player1Hand),
          player2Hand: JSON.parse(game.player2Hand),
        }
      }), { status: 200 });
    }

    // fallback
    return new Response(JSON.stringify({
      success: true,
      status: "finished",
    }), { status: 200 });

  } catch (err) {
    console.error("UNO check-game error:", err);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), { status: 500 });
  }
}
