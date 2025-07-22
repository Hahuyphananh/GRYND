import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState } from "../../../lib/unogameutils"; // Assume you have game state management
import { applyUnoCard } from "../../../lib/unoLogic"; // Function to apply card effects

export async function POST(request) {
  try {
    const { gameId, card } = await request.json();

    const game = await getUnoGameById(gameId);
    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    const playerHand = game.playerHand || [];
    const topCard = game.topCard;

    // Check if card is in hand
    const cardIndex = playerHand.findIndex(
      c => c.color === card.color && c.value === card.value
    );
    if (cardIndex === -1) {
      return NextResponse.json({ success: false, error: "Invalid card" }, { status: 400 });
    }

    // Check playability
    const isPlayable =
      card.color === topCard.color ||
      card.value === topCard.value ||
      card.color === "wild";

    if (!isPlayable) {
      return NextResponse.json({ success: false, error: "Card not playable" }, { status: 400 });
    }

    // Remove card from hand
    playerHand.splice(cardIndex, 1);

    // Apply card effects (e.g., Skip, Reverse, Draw Two)
    const updatedGame = applyUnoCard(game, card, "player");

    updatedGame.playerHand = playerHand;
    updatedGame.topCard = card;
    updatedGame.isPlayerTurn = false;

    await updateUnoGameState(gameId, updatedGame);

    return NextResponse.json({
      success: true,
      data: {
        playerHand,
        topCard: card,
        aiHandCount: updatedGame.aiHand.length,
        isPlayerTurn: false,
        message: "Carte jouée, au tour de l’IA"
      }
    });
  } catch (error) {
    console.error("Error in /api/uno/play-card:", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
