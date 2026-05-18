import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users, pokerGames } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { compareHands, dealCommunityCards } from "../../lib/ailogic";
import { recordBigWinIfNeeded } from "../../../lib/bigWins";

export async function POST(request) {
  const { userId } = await auth();
  if (!userId)
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );

  const { gameId, action } = await request.json();
  if (!gameId || !action)
    return new Response(
      JSON.stringify({ success: false, error: "Missing parameters" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!user) throw new Error("User not found");

    const game = await db.query.pokerGames.findFirst({
      where: eq(pokerGames.id, gameId),
    });
    if (!game || game.status !== "active")
      throw new Error("Game not found or inactive");

    let userBalance = parseFloat(user.balance);
    let pot = parseFloat(game.pot || 0);
    const betAmount = parseFloat(game.betAmount || 10);

    // --- Fold action (Lose half bet) ---
    if (action === "fold") {
      const loss = betAmount / 2; // only lose half
      const refund = betAmount - loss; // refunded half
      userBalance += refund; // return half of the player's bet

      const resultMessage = `You folded and lost half your bet (-${loss} tokens).`;

      await db.transaction(async (tx) => {
        await tx
          .update(pokerGames)
          .set({
            result: "lose",
            status: "finished",
            pot: 0,
          })
          .where(eq(pokerGames.id, gameId));

        await tx
          .update(users)
          .set({ balance: userBalance })
          .where(eq(users.clerkId, userId));
      });

      const playerHand = game.playerHand || [];
      const aiHand = game.aiHand || [];

      return new Response(
        JSON.stringify({
          success: true,
          game: { ...game, result: "lose", status: "finished" },
          positions: [
            { player_id: user.id, hand: playerHand },
            { player_id: null, hand: aiHand.map(() => "?") },
          ],
          result: {
            message: resultMessage,
            won: false,
            winAmount: 0,
            bet: loss,
          },
          newBalance: userBalance,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // --- Play action ---
    if (action === "play") {
      const playBet = betAmount * 2;
      if (userBalance < playBet) throw new Error("Not enough tokens");

      userBalance -= playBet;
      pot += playBet;

      const playerHand = game.playerHand;
      const aiHand = game.aiHand;

      const communityCards = dealCommunityCards(
        game.communityCards || [],
        playerHand,
        aiHand,
      );

      const fullPlayerHand = [...playerHand, ...communityCards.newCommunity];
      const fullAiHand = [...aiHand, ...communityCards.newCommunity];

      const winner = compareHands(fullPlayerHand, fullAiHand);
      const result =
        winner === "player" ? "win" : winner === "dealer" ? "lose" : "tie";

      let winAmount = 0;
      if (result === "win") {
        winAmount = pot;
        userBalance += winAmount;
      }

      // Record big win if winAmount >= 1 million tokens
      if (winAmount >= 1000000) {
        const clerkUser = await currentUser();
        recordBigWinIfNeeded({
          userId: userId,
          username: clerkUser?.firstName ? `${clerkUser.firstName} ${clerkUser.lastName || ""}`.trim() : "Player",
          game: "Poker",
          betAmount: playBet,
          winAmount: winAmount,
          multiplier: playBet > 0 ? winAmount / playBet : 0,
        }).catch(() => {}); // Fire and forget
      }

      await db.transaction(async (tx) => {
        await tx
          .update(pokerGames)
          .set({
            pot,
            result,
            communityCards: communityCards.newCommunity,
            aiHand,
          })
          .where(eq(pokerGames.id, gameId));

        await tx
          .update(users)
          .set({ balance: userBalance })
          .where(eq(users.clerkId, userId));
      });

      return new Response(
        JSON.stringify({
          success: true,
          game: {
            ...game,
            pot,
            result,
            communityCards: communityCards.newCommunity,
            aiHand,
          },
          positions: [
            { player_id: user.id, hand: playerHand },
            { player_id: null, hand: aiHand },
          ],
          result: {
            message: `Hand over. ${
              result === "win"
                ? "You won!"
                : result === "lose"
                  ? "Dealer wins!"
                  : "It's a tie."
            }`,
            won: result === "win",
            winAmount,
            bet: playBet,
          },
          newBalance: userBalance,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error("Invalid action");
  } catch (err) {
    console.error("❌ Poker action error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || "Server error" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
