import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, unoGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { getUnoGameById, updateUnoGameState, drawUnoCard } from "../../../lib/unoGameUtils";

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

export async function POST(req) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

    const { gameId } = await req.json();
    const game = await getUnoGameById(gameId);
    if (!game) return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });

    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!user) return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });

    const isMultiplayer = Boolean(game.player2Id);

    if (isMultiplayer) {
      if (game.status !== "active") {
        return NextResponse.json({ success: false, error: "Game is not active" }, { status: 400 });
      }

      const role = game.userId === user.id ? "player1" : game.player2Id === user.id ? "player2" : null;
      if (!role) {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
      }

      if (game.turn !== role) {
        return NextResponse.json({ success: false, error: "Not your turn" }, { status: 400 });
      }

      const deck = safeParse(game.deck, []);
      const player1Hand = safeParse(game.player1Hand, []);
      const player2Hand = safeParse(game.player2Hand, []);
      const discardPile = safeParse(game.discardPile, []);

      const { card, deck: updatedDeck } = drawUnoCard(deck);
      if (!card) {
        return NextResponse.json({ success: false, error: "Deck empty" }, { status: 400 });
      }

      const updatedPlayer1Hand = role === "player1" ? [...player1Hand, card] : player1Hand;
      const updatedPlayer2Hand = role === "player2" ? [...player2Hand, card] : player2Hand;
      const updatedTurn = role === "player1" ? "player2" : "player1";

      await db
        .update(unoGames)
        .set({
          deck: updatedDeck,
          player1Hand: updatedPlayer1Hand,
          player2Hand: updatedPlayer2Hand,
          discardPile,
          turn: updatedTurn,
        })
        .where(eq(unoGames.id, gameId));

      return NextResponse.json({
        success: true,
        data: {
          mode: "online",
          role,
          playerHand: role === "player1" ? updatedPlayer1Hand : updatedPlayer2Hand,
          opponentHandCount: role === "player1" ? updatedPlayer2Hand.length : updatedPlayer1Hand.length,
          topCard: discardPile[discardPile.length - 1],
          message: "Tu as pioché une carte.",
          isPlayerTurn: false,
          currentColor: game.currentColor,
        },
      });
    }

    const deck = safeParse(game.deck, []);
    const playerHand = safeParse(game.playerHand, []);
    const discardPile = safeParse(game.discardPile, []);

    const { card, deck: updatedDeck } = drawUnoCard(deck);
    playerHand.push(card);

    const updatedGame = {
      ...game,
      deck: updatedDeck,
      playerHand,
      discardPile,
      currentColor: game.currentColor,
      isPlayerTurn: false,
    };

    await updateUnoGameState(gameId, updatedGame);

    return NextResponse.json({
      success: true,
      data: {
        mode: "ai",
        playerHand,
        topCard: discardPile[discardPile.length - 1],
        message: "Tu as pioché une carte.",
        isPlayerTurn: false,
        currentColor: game.currentColor,
      },
    });
  } catch (err) {
    console.error("Error in draw-card:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
