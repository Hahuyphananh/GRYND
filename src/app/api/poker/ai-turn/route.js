import { db } from "../../../../db/client";
import { pokerGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

/**
 * POST /api/poker/ai-turn
 * Handles the AI turn for an ongoing poker game.
 */
export async function POST(req) {
  try {
    const { gameId } = await req.json();
    if (!gameId) {
      return Response.json({ success: false, error: "Missing gameId" }, { status: 400 });
    }

    // Fetch game
    const game = await db.query.pokerGames.findFirst({
      where: eq(pokerGames.id, gameId),
    });
    if (!game) {
      return Response.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Parse hands & pot
    const aiHand = game.aiHand ? JSON.parse(game.aiHand) : ["?", "?"];
    const playerHand = game.playerHand ? JSON.parse(game.playerHand) : ["?", "?"];
    let pot = parseInt(game.pot || 0, 10);

    // --- Simple AI Logic ---
    // Random action: 50% call, 25% raise, 25% fold
    const rand = Math.random();
    let aiAction = "call";
    let aiRaiseAmount = 0;

    if (rand < 0.25) {
      aiAction = "fold";
    } else if (rand > 0.75) {
      aiAction = "raise";
      aiRaiseAmount = 10; // fixed raise for simplicity
      pot += aiRaiseAmount;
    } else {
      aiAction = "call";
      pot += 10; // simulate a call matching 10 tokens
    }

    // Update game state
    const updatedGame = {
      ...game,
      aiHand: JSON.stringify(aiHand),
      playerHand: JSON.stringify(playerHand),
      pot,
      lastAction: `AI ${aiAction}${aiAction === "raise" ? ` ${aiRaiseAmount}` : ""}`,
    };

    await db.update(pokerGames)
      .set({
        pot: pot.toString(),
        aiHand: updatedGame.aiHand,
        playerHand: updatedGame.playerHand,
        lastAction: updatedGame.lastAction,
      })
      .where(eq(pokerGames.id, gameId));

    return Response.json({
      success: true,
      data: {
        aiAction,
        aiRaiseAmount,
        pot,
        aiHandCount: aiHand.length,
        lastAction: updatedGame.lastAction,
      },
    });
  } catch (err) {
    console.error("Poker AI Turn Error:", err);
    return Response.json({ success: false, error: "Internal Server Error" }, { status: 500 });
  }
}
