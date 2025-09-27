import { db } from "../../../../db/client";
import { getUnoGameById, drawUnoCard, updateUnoGameState } from "../../../lib/unoGameUtils";
import { applyUnoCard } from "../../../lib/unoLogic";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

// Safe parse utility
function safeParse(data) {
  if (!data) return [];
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return []; }
  }
  return data;
}

// AI chooses color with most cards
function aiChooseColor(hand) {
  const colorCount = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const card of hand) if (colorCount[card.color] !== undefined) colorCount[card.color]++;
  return Object.keys(colorCount).reduce((a, b) => colorCount[a] > colorCount[b] ? a : b, "red");
}

export async function POST(req) {
  try {
    const { gameId } = await req.json();
    if (!gameId) return new Response(JSON.stringify({ success: false, error: "Missing gameId" }), { status: 400 });

    const game = await getUnoGameById(gameId);
    if (!game) return new Response(JSON.stringify({ success: false, error: "Game not found" }), { status: 404 });

    // Parse state safely
    let deck = safeParse(game.deck);
    let aiHand = safeParse(game.aiHand);
    let playerHand = safeParse(game.playerHand);
    let discardPile = safeParse(game.discardPile);
    let topCard = discardPile[discardPile.length - 1] || null;
    let currentColor = game.currentColor || topCard?.color;
    let message = "";
    let isPlayerTurn = false;

    // Safety counter to prevent infinite loops
    let loopCounter = 0;

    while (!isPlayerTurn && loopCounter < 20) {
      loopCounter++;

      // Prefer Skip or Reverse if possible (for testing)
let playableIndex = aiHand.findIndex(card => card.value === "Skip" || card.value === "Reverse");

// If no Skip/Reverse, fall back to any normal playable card
if (playableIndex === -1) {
  playableIndex = aiHand.findIndex(card =>
    card.color === "black" || card.color === currentColor || card.value === topCard.value
  );
}


      if (playableIndex >= 0) {
        // Play the card
        let playedCard = aiHand.splice(playableIndex, 1)[0];

        // If wild, choose color
        if (playedCard.color === "black") {
          playedCard.color = aiChooseColor(aiHand) || "red";
          message = `IA joue ${playedCard.value} et choisit ${playedCard.color}`;
        } else {
          message = `IA joue ${playedCard.color} ${playedCard.value}`;
        }

        const updatedGame = applyUnoCard(
          { deck, playerHand, aiHand, discardPile, currentColor, turn: "ai" },
          playedCard,
          "ai",
          playedCard.color
        );

        // Update state from applyUnoCard
        deck = updatedGame.deck;
        aiHand = updatedGame.aiHand;
        playerHand = updatedGame.playerHand;
        discardPile = updatedGame.discardPile;
        currentColor = updatedGame.currentColor;
        topCard = discardPile[discardPile.length - 1];
        isPlayerTurn = updatedGame.turn === "player";
if (updatedGame.turn === "ai") {
  // AI kept the turn (Skip or Reverse), so let the loop continue
  continue;
}


      } else {
        // Draw a card if no playable card
        const drawnCard = drawUnoCard({ deck, playerHand, aiHand, discardPile, currentColor, turn: "ai" });
        aiHand.push(drawnCard);
        message = "IA pioche une carte";
        isPlayerTurn = true; // End AI turn after drawing
      }
    }

    // Save updated game state
    const updatedGameState = { deck, playerHand, aiHand, discardPile, topCard, currentColor, isPlayerTurn };
    await updateUnoGameState(gameId, updatedGameState);

    const user = await db.query.users.findFirst({ where: eq(users.id, game.userId) });

    return new Response(JSON.stringify({
      success: true,
      data: {
        topCard,
        playerHand,
        aiHandCount: aiHand.length,
        newBalance: parseFloat(user.balance),
        message,
        isPlayerTurn,
        currentColor
      }
    }), { status: 200 });

  } catch (err) {
    console.error("AI Turn Error:", err);
    return new Response(JSON.stringify({ success: false, error: "Internal Server Error" }), { status: 500 });
  }
}
