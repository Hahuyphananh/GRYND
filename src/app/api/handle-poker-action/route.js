import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users, pokerGames } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { performAiAction } from "../../lib/ailogic";

export async function POST(request) {
  const { userId } = await auth();
  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const { gameId, action, amount } = await request.json();

  if (!gameId || !action) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing required parameters" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const games = await db.select().from(pokerGames).where(eq(pokerGames.id, gameId));
    const game = games[0];

    if (!game || game.status !== "active") {
      return new Response(
        JSON.stringify({ success: false, error: "Game not found or inactive" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    let pot = parseFloat(game.pot || 0);
    let result = game.result;

    // Handle player's action
    if (action === "call") {
      pot += parseFloat(game.betAmount || 10); // default call = 10
    } else if (action === "raise" && amount) {
      pot += parseFloat(amount);
    } else if (action === "fold") {
      result = "lose";
    }

    // Update game state after player action
    await db
      .update(pokerGames)
      .set({ pot, result })
      .where(eq(pokerGames.id, gameId));

    // If player folded, no AI move needed
    if (action !== "fold") {
      await performAiAction(gameId);
    }

    const updatedGame = await db.query.pokerGames.findFirst({
      where: eq(pokerGames.id, gameId),
    });

    const isShowdown = updatedGame?.result && updatedGame.result !== "pending";

    return new Response(
      JSON.stringify({
        success: true,
        game: updatedGame,
        positions: [
          {
            player_id: user.id,
            hand: updatedGame.playerHand,
          },
          {
            player_id: null,
            hand: isShowdown
              ? updatedGame.aiHand
              : JSON.stringify(["?", "?"]),
          },
        ],
        result: isShowdown
          ? {
              message: "Fin de la main.",
              won: updatedGame.result === "win",
              winAmount: parseFloat(updatedGame.pot || 0),
              bet: parseFloat(updatedGame.betAmount || 0),
            }
          : null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("❌ Poker action error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
