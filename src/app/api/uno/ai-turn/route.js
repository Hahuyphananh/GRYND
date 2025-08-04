import { db } from "../../../../db/client";
import { getUnoGameById, drawUnoCard, updateUnoGameState } from "../../../lib/unogameutils";
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

    // 1️⃣ Get the game
    const game = await getUnoGameById(gameId);
    if (!game) {
      return Response.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // 2️⃣ Parse JSON fields safely
    let deck = safeParse(game.deck) || [];
    let aiHand = safeParse(game.aiHand) || [];
    let playerHand = safeParse(game.playerHand) || [];
    let topCard = safeParse(game.topCard) || null;

    // 🔹 If no topCard exists, draw one to start the pile
    if (!topCard || !topCard.color) {
      if (deck.length === 0) {
        return Response.json({ success: false, error: "Deck empty" }, { status: 500 });
      }
      topCard = deck.shift();
    }

    // 3️⃣ Simple AI logic
    const playableIndex = aiHand.findIndex(
      (card) =>
        card?.color === topCard.color ||
        card?.value === topCard.value ||
        card?.color === "wild" || card?.color === "black"
    );

    let message = "";
    if (playableIndex >= 0) {
      // AI plays a card
      const playedCard = aiHand.splice(playableIndex, 1)[0];
      topCard = playedCard;
      message = `IA joue ${playedCard.color} ${playedCard.value}`;
    } else {
      // AI draws a card
      const newCard = drawUnoCard({ deck });
      aiHand.push(newCard);
      message = `IA pioche une carte`;
    }

    // 4️⃣ Update game state
    const updatedGame = {
      deck,
      playerHand,
      aiHand,
      topCard,
      isPlayerTurn: true,
    };
    await updateUnoGameState(gameId, updatedGame);

    // 5️⃣ Return response with AI state + balance
    const user = await db.query.users.findFirst({ where: eq(users.id, game.userId) });

    return Response.json({
      success: true,
      data: {
        topCard,
        aiHandCount: aiHand.length,
        newBalance: parseFloat(user.balance),
        message,
      },
    });
  } catch (err) {
    console.error("AI Turn Error:", err);
    return Response.json({ success: false, error: "Internal Server Error" }, { status: 500 });
  }
}
