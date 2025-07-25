import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState, drawUnoCard } from "../../../lib/unogameutils";

export async function POST(request) {
  try {
    const { gameId } = await request.json();

    const game = await getUnoGameById(gameId);
    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // 🛠️ Safely parse deck and playerHand if needed
    game.deck = typeof game.deck === "string" ? JSON.parse(game.deck) : game.deck;
    game.playerHand = typeof game.playerHand === "string" ? JSON.parse(game.playerHand) : game.playerHand;

    // ✅ Draw a card
    const newCard = drawUnoCard(game);
    game.playerHand.push(newCard);

    // 🌀 Turn ends after drawing
    game.isPlayerTurn = false;

    // 💾 Save back updated game state
    await updateUnoGameState(gameId, {
      ...game,
      deck: JSON.stringify(game.deck),
      playerHand: JSON.stringify(game.playerHand),
      isPlayerTurn: game.isPlayerTurn
    });

    return NextResponse.json({
      success: true,
      data: {
        playerHand: game.playerHand,
        message: `Tu as pioché une carte.`,
        isPlayerTurn: false
      }
    });
  } catch (error) {
    console.error("Error in /api/uno/draw-card:", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
