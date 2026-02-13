import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState } from "../../../lib/unoGameUtils";
import { applyUnoCard } from "../../../lib/unoLogic";

export async function POST(req) {
  try {
    const { gameId, card, chosenColor } = await req.json();

    const game = await getUnoGameById(gameId);
    if (!game) return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });

    const playerHand = typeof game.playerHand === "string" ? JSON.parse(game.playerHand) : game.playerHand;
    const aiHand = typeof game.aiHand === "string" ? JSON.parse(game.aiHand) : game.aiHand;
    const deck = typeof game.deck === "string" ? JSON.parse(game.deck) : game.deck;
    let discardPile;

if (!game.discardPile) {
  // rebuild pile from topCard if missing
  discardPile = game.topCard
    ? [typeof game.topCard === "string"
        ? JSON.parse(game.topCard)
        : game.topCard]
    : [];
} else {
  discardPile = typeof game.discardPile === "string"
    ? JSON.parse(game.discardPile)
    : game.discardPile;
}

    const topCard = discardPile[discardPile.length - 1] || null;
    const currentColor = game.currentColor || topCard?.color;

    // Ensure the card exists in the player's hand
    const cardIndex = playerHand.findIndex(c => c.color === card.color && c.value === card.value);
    if (cardIndex === -1) return NextResponse.json({ success: false, error: "Invalid card" }, { status: 400 });

    // Check playability using currentColor
    const isPlayable = card.color === currentColor || card.value === topCard.value || card.color === "black";
    if (!isPlayable) return NextResponse.json({ success: false, error: "Card not playable" }, { status: 400 });

    // Handle wild color selection
    if ((card.value === "Wild" || card.value === "Wild Draw Four") && !chosenColor) {
      return NextResponse.json({ success: true, needsColorChoice: true, card });
    }

    // Play the card
    const playedCard = { ...card, color: chosenColor || card.color };
    playerHand.splice(cardIndex, 1);

    const updatedGame = applyUnoCard(
      { ...game, playerHand, aiHand, deck, discardPile, currentColor },
      playedCard,
      "player",
      chosenColor
    );

    await updateUnoGameState(gameId, updatedGame);

    return NextResponse.json({
      success: true,
      data: {
        playerHand: updatedGame.playerHand,
        aiHandCount: updatedGame.aiHand.length,
        topCard: updatedGame.discardPile[updatedGame.discardPile.length - 1],
        currentColor: updatedGame.currentColor,
        isPlayerTurn: updatedGame.turn === "player",
        message: updatedGame.turn === "player" ? "Carte jouée, ton tour" : "Carte jouée, tour IA"
      }
    });
  } catch (err) {
    console.error("Error in play-card:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
