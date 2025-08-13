import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState } from "../../../lib/unoGameUtils";
import { applyUnoCard } from "../../../lib/unoLogic";

function safeParseCard(data) {
  if (!data) return null;
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      // Sometimes nested JSON string
      return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    } catch {
      return null;
    }
  }
  return data;
}

export async function POST(request) {
  try {
    const { gameId, card } = await request.json();

    const game = await getUnoGameById(gameId);

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    const playerHand = safeParseCard(game.playerHand) || [];
    const aiHand = safeParseCard(game.aiHand) || [];
    const deck = safeParseCard(game.deck) || [];
    const discardPile = safeParseCard(game.discardPile) || [];
    const topCard = discardPile.length > 0 ? discardPile[discardPile.length - 1] : null;

    // Ensure card exists in player's hand
    const cardIndex = playerHand.findIndex(
      (c) => c.color === card.color && c.value === card.value
    );
    if (cardIndex === -1) {
      return NextResponse.json({ success: false, error: "Invalid card" }, { status: 400 });
    }

    // Playability check
    const isPlayable =
      card.color === topCard?.color ||
      card.value === topCard?.value ||
      card.color === "wild" ||
      card.color === "black";

    if (!isPlayable) {
      return NextResponse.json({ success: false, error: "Card not playable" }, { status: 400 });
    }

    // Remove the card from player's hand
    playerHand.splice(cardIndex, 1);

    // Add the played card to discard pile
    const newDiscardPile = [...discardPile, card];

    // Apply card effect with updated discard pile
    const updatedGame = applyUnoCard(
      { ...game, playerHand, aiHand, deck, discardPile: newDiscardPile, topCard: card },
      card,
      "player"
    );

    // Update topCard to last card in updated discard pile
    const newTopCard = updatedGame.discardPile[updatedGame.discardPile.length - 1];

    updatedGame.playerHand = playerHand;
    updatedGame.topCard = newTopCard;
    updatedGame.isPlayerTurn = false;

    await updateUnoGameState(gameId, updatedGame);

    return NextResponse.json({
      success: true,
      data: {
        playerHand,
        topCard: newTopCard,
        aiHandCount: updatedGame.aiHand.length,
        isPlayerTurn: false,
        message: "Carte jouée, au tour de l’IA",
      },
    });
  } catch (error) {
    console.error("Error in /api/uno/play-card:", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
