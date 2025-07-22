import { NextResponse } from "next/server";
import { getUnoGameById, updateUnoGameState, drawUnoCard } from "@/lib/unoGameUtils";

export async function POST(request) {
  try {
    const { gameId } = await request.json();

    const game = await getUnoGameById(gameId);
    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    const newCard = drawUnoCard(game); // Draw from deck
    game.playerHand.push(newCard);

    game.isPlayerTurn = false; // Turn ends after drawing
    await updateUnoGameState(gameId, game);

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
