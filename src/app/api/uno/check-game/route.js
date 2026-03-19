import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { unoGames, users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

function safeParse(value, fallback = []) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

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

    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!user) {
      return new Response(JSON.stringify({ success: false, error: "User not found" }), { status: 404 });
    }

    const isMultiplayer = Boolean(game.player2Id);
    const isPlayer1 = game.userId === user.id;
    const isPlayer2 = game.player2Id === user.id;

    if (isMultiplayer && !isPlayer1 && !isPlayer2) {
      return new Response(JSON.stringify({ success: false, error: "Forbidden" }), { status: 403 });
    }

    if (game.status === "waiting") {
      if (!isPlayer1) {
        return new Response(JSON.stringify({ success: false, error: "Forbidden" }), { status: 403 });
      }

      return new Response(JSON.stringify({
        success: true,
        status: "waiting",
      }), { status: 200 });
    }

    if (!isMultiplayer) {
      return new Response(JSON.stringify({
        success: true,
        status: game.status,
        data: {
          id: game.id,
          mode: "ai",
          topCard: safeParse(game.topCard, null),
          currentColor: game.currentColor,
          turn: game.turn,
          playerHand: safeParse(game.playerHand, []),
          aiHandCount: safeParse(game.aiHand, []).length,
        },
      }), { status: 200 });
    }

    const role = isPlayer1 ? "player1" : "player2";
    const player1Hand = safeParse(game.player1Hand, []);
    const player2Hand = safeParse(game.player2Hand, []);

    const myHand = role === "player1" ? player1Hand : player2Hand;
    const opponentHandCount = role === "player1" ? player2Hand.length : player1Hand.length;

    return new Response(JSON.stringify({
      success: true,
      status: game.status,
      data: {
        id: game.id,
        mode: "online",
        role,
        topCard: safeParse(game.topCard, null),
        currentColor: game.currentColor,
        turn: game.turn,
        playerHand: myHand,
        opponentHandCount,
        winner: game.winner,
        result: game.result,
      },
    }), { status: 200 });
  } catch (err) {
    console.error("UNO check-game error:", err);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), { status: 500 });
  }
}
