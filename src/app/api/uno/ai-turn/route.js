import { db } from "../../../../db/client";
import { getUnoGameById, drawUnoCard, updateUnoGameState } from "../../../lib/unoGameUtils";
import { applyUnoCard } from "../../../lib/unoLogic";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

// ✅ Parse JSON only if it's a string
function safeParse(data) {
  if (!data) return null;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  return data; // already an object
}

export async function POST(req) {
  try {
    const { gameId } = await req.json();
    if (!gameId) {
      return Response.json({ success: false, error: "Missing gameId" }, { status: 400 });
    }

    // 1️⃣ Get the game from DB
    const game = await getUnoGameById(gameId);
    if (!game) {
      return Response.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // 2️⃣ Parse all necessary fields safely
    let deck = safeParse(game.deck) || [];
    let aiHand = safeParse(game.aiHand) || [];
    let playerHand = safeParse(game.playerHand) || [];
    let discardPile = safeParse(game.discardPile) || [];
    let topCard = discardPile.length ? discardPile[discardPile.length - 1] : null;

    let message = "";
    let isPlayerTurn = false; // AI will start playing

    // Loop AI turn while AI has playable cards and it's AI's turn
    while (!isPlayerTurn) {
      // Find playable card for AI
      const playableIndex = aiHand.findIndex(
        (card) =>
          card.color === topCard.color ||
          card.value === topCard.value ||
          card.color === "wild" ||
          card.color === "black"
      );

      if (playableIndex >= 0) {
        // AI plays the card
        const playedCard = aiHand.splice(playableIndex, 1)[0];

        // Apply the Uno card effects
        const updatedGame = applyUnoCard(
          {
            deck,
            playerHand,
            aiHand,
            discardPile,
            topCard,
            turn: "ai",
          },
          playedCard,
          "ai"
        );

        // Update game state from the result of applyUnoCard
        deck = updatedGame.deck;
        aiHand = updatedGame.aiHand;
        playerHand = updatedGame.playerHand;
        discardPile = updatedGame.discardPile;

        topCard = discardPile[discardPile.length - 1] || null;

        // Update isPlayerTurn flag based on updated turn
        isPlayerTurn = updatedGame.turn === "player";

        message = `IA joue ${playedCard.color} ${playedCard.value}`;

        // If AI turn continues, loop again automatically
        if (!isPlayerTurn) {
          message += " et rejoue.";
        }
      } else {
        // No playable card, AI draws one and ends turn
        const newCard = drawUnoCard({ deck });
        aiHand.push(newCard);
        message = `IA pioche une carte`;
        isPlayerTurn = true; // AI ends turn after drawing
      }
    }

    // 4️⃣ Save updated game state in DB
    const updatedGameState = {
      deck,
      playerHand,
      aiHand,
      discardPile,
      topCard,
      isPlayerTurn,
    };

    await updateUnoGameState(gameId, updatedGameState);

    // 5️⃣ Get updated user balance
    const user = await db.query.users.findFirst({ where: eq(users.id, game.userId) });

    // 6️⃣ Return updated game state to frontend
    return Response.json({
      success: true,
      data: {
        topCard,
        playerHand,           // updated player hand (includes drawn cards if any)
        aiHandCount: aiHand.length,
        newBalance: parseFloat(user.balance),
        message,
        isPlayerTurn,
      },
    });
  } catch (err) {
    console.error("AI Turn Error:", err);
    return Response.json({ success: false, error: "Internal Server Error" }, { status: 500 });
  }
}
