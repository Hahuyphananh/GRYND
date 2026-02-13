import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState, drawUnoCard } from "../../../lib/unoGameUtils";

export async function POST(req) {
  try {
    const { gameId } = await req.json();
    const game = await getUnoGameById(gameId);
    if (!game) return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });

const deck = typeof game.deck === "string" ? JSON.parse(game.deck) : game.deck;
const playerHand = typeof game.playerHand === "string" ? JSON.parse(game.playerHand) : game.playerHand;
const discardPile = typeof game.discardPile === "string"
  ? JSON.parse(game.discardPile)
  : game.discardPile;

const { card, deck: updatedDeck } = drawUnoCard(deck);
playerHand.push(card);

const updatedGame = { 
  ...game,
  deck: updatedDeck,
  playerHand,
  discardPile,          // ⭐ NEVER DROP THIS
  currentColor: game.currentColor, // ⭐ NEVER DROP THIS
  isPlayerTurn: false
};

await updateUnoGameState(gameId, updatedGame);

    return NextResponse.json({
      success: true,
      data: { 
  playerHand,
  topCard: discardPile[discardPile.length - 1], // ⭐ CRITICAL
  message: "Tu as pioché une carte.",
  isPlayerTurn: false,
  currentColor: game.currentColor
}
    });
  } catch (err) {
    console.error("Error in draw-card:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
