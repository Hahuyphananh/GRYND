import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState } from "../../../lib/unogameutils"; // game state management
import { applyUnoCard } from "../../../lib/unoLogic"; // Function to apply card effects

function safeParse(data) {
  if (!data) return null;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data; // already parsed
}

export async function POST(request) {
  try {
    const { gameId, card } = await request.json();

    const game = await getUnoGameById(gameId);
    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Parse game state safely
    const playerHand = safeParse(game.playerHand) || [];
    const aiHand = safeParse(game.aiHand) || [];
    const deck = safeParse(game.deck) || [];
    const topCard = safeParse(game.topCard);

    // Check if card is in hand
    const cardIndex = playerHand.findIndex(
      (c) => c.color === card.color && c.value === card.value
    );
    if (cardIndex === -1) {
      return NextResponse.json({ success: false, error: "Invalid card" }, { status: 400 });
    }

    // Check playability
    const isPlayable =
      card.color === topCard?.color ||
      card.value === topCard?.value ||
      card.color === "wild" ||
      card.color === "black"; // for wild cards

    if (!isPlayable) {
      return NextResponse.json({ success: false, error: "Card not playable" }, { status: 400 });
    }

    // Remove card from hand
    playerHand.splice(cardIndex, 1);

    // Apply card effects - pass parsed game state and current card
    const updatedGame = applyUnoCard(
      { ...game, playerHand, aiHand, deck, topCard },
      card,
      "player"
    );

    // Update topCard, playerHand and turn state explicitly
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
        message: "Carte jouée, au tour de l’IA",
      },
    });
  } catch (error) {
    console.error("Error in /api/uno/play-card:", error);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
