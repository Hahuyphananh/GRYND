import { db } from "../../../../db/client";
import { getUnoGameById, drawUnoCard, updateUnoGameState } from "../../../lib/unoGameUtils";
import { applyUnoCard } from "../../../lib/unoLogic";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

function safeParse(data) {
  if (!data) return null;
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return null; }
  }
  return data;
}

function aiChooseColor(aiHand) {
  const colorCount = { red: 0, blue: 0, green: 0, yellow: 0 };
  for (const card of aiHand) {
    if (colorCount.hasOwnProperty(card.color)) colorCount[card.color]++;
  }
  return Object.keys(colorCount).reduce((a, b) => colorCount[a] > colorCount[b] ? a : b);
}

export async function POST(req) {
  try {
    const { gameId } = await req.json();
    if (!gameId) return Response.json({ success: false, error: "Missing gameId" }, { status: 400 });

    const game = await getUnoGameById(gameId);
    if (!game) return Response.json({ success: false, error: "Game not found" }, { status: 404 });

    let deck = safeParse(game.deck) || [];
    let aiHand = safeParse(game.aiHand) || [];
    let playerHand = safeParse(game.playerHand) || [];
    let discardPile = safeParse(game.discardPile) || [];
    let topCard = discardPile[discardPile.length - 1] || null;
    let currentColor = game.currentColor || topCard?.color;

    let message = "";
    let isPlayerTurn = false;

    while (!isPlayerTurn) {
      // Find playable card
      const playableIndex = aiHand.findIndex(card => card.color === "black" || card.color === currentColor || card.value === topCard.value);

      if (playableIndex >= 0) {
        let playedCard = aiHand.splice(playableIndex, 1)[0];

        // If Wild, choose color
        if (playedCard.color === "black") {
          const chosenColor = aiChooseColor(aiHand) || "red";
          playedCard.color = chosenColor;
          currentColor = chosenColor;
          message = `IA joue ${playedCard.value} et choisit ${chosenColor}`;
          // applyUnoCard updates currentColor internally too
          const updatedGame = applyUnoCard(
            { deck, playerHand, aiHand, discardPile, currentColor, turn: "ai" },
            playedCard,
            "ai",
            chosenColor
          );
          deck = updatedGame.deck;
          aiHand = updatedGame.aiHand;
          playerHand = updatedGame.playerHand;
          discardPile = updatedGame.discardPile;
          currentColor = updatedGame.currentColor;
          topCard = discardPile[discardPile.length - 1];
          isPlayerTurn = updatedGame.turn === "player";
        } else {
          // Normal card
          message = `IA joue ${playedCard.color} ${playedCard.value}`;
          const updatedGame = applyUnoCard(
            { deck, playerHand, aiHand, discardPile, currentColor, turn: "ai" },
            playedCard,
            "ai"
          );
          deck = updatedGame.deck;
          aiHand = updatedGame.aiHand;
          playerHand = updatedGame.playerHand;
          discardPile = updatedGame.discardPile;
          currentColor = updatedGame.currentColor;
          topCard = discardPile[discardPile.length - 1];
          isPlayerTurn = updatedGame.turn === "player";
        }
      } else {
        // Draw a card if none playable
        const newCard = drawUnoCard(deck);
        aiHand.push(newCard);
        message = "IA pioche une carte";
        isPlayerTurn = true; // end turn after draw
      }
    }

    const updatedGameState = { deck, playerHand, aiHand, discardPile, topCard, currentColor, isPlayerTurn };
    await updateUnoGameState(gameId, updatedGameState);

    const user = await db.query.users.findFirst({ where: eq(users.id, game.userId) });

    return Response.json({
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
    });
  } catch (err) {
    console.error("AI Turn Error:", err);
    return Response.json({ success: false, error: "Internal Server Error" }, { status: 500 });
  }
}
