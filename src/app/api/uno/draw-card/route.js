import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState, drawUnoCard } from "../../../lib/unoGameUtils";

export async function POST(req) {
  try {
    const { gameId } = await req.json();
    const game = await getUnoGameById(gameId);
    if (!game) return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });

    const deck = typeof game.deck === "string" ? JSON.parse(game.deck) : game.deck;
    const playerHand = typeof game.playerHand === "string" ? JSON.parse(game.playerHand) : game.playerHand;

    const newCard = drawUnoCard({ deck });
    playerHand.push(newCard);

    const updatedGame = { ...game, deck, playerHand, turn: "ai" };
    await updateUnoGameState(gameId, updatedGame);

    return NextResponse.json({
      success: true,
      data: { playerHand, message: "Tu as pioché une carte.", isPlayerTurn: false, currentColor: game.currentColor }
    });
  } catch (err) {
    console.error("Error in draw-card:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
