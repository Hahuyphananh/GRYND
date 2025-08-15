import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users, pokerGames } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { performAiAction, compareHands, dealCommunityCards } from "../../lib/ailogic";

export async function POST(request) {
  const { userId } = await auth();
  if (!userId)
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });

  const { gameId, action } = await request.json();
  if (!gameId || !action)
    return new Response(JSON.stringify({ success: false, error: "Missing parameters" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const user = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!user) throw new Error("User not found");

    const game = await db.query.pokerGames.findFirst({ where: eq(pokerGames.id, gameId) });
    if (!game || game.status !== "active") throw new Error("Game not found or inactive");

    let userBalance = parseFloat(user.balance);
    let pot = parseFloat(game.pot || 0);
    const betAmount = parseFloat(game.betAmount || 10);

    // --- Fold action ---
if (action === "fold") {
  const resultMessage = "You folded. Dealer wins.";

  // Update DB
  await db.transaction(async (tx) => {
    await tx.update(pokerGames).set({ result: "lose" }).where(eq(pokerGames.id, gameId));
    // Player already paid ante; balance stays the same
  });

  const userBalance = parseFloat(user.balance);

  return new Response(JSON.stringify({
    success: true,
    game: { ...game, result: "lose" },
    positions: [
      { player_id: user.id, hand: game.playerHand }, // no JSON.parse needed
      { player_id: null, hand: ["?", "?"] },
    ],
    result: {
      message: resultMessage,
      won: false,
      winAmount: 0,
      bet: parseFloat(game.betAmount || 10),
    },
    newBalance: userBalance,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}


    // --- Play action ---
if (action === "play") {
  const playBet = betAmount * 2;
  if (userBalance < playBet) throw new Error("Not enough tokens");

  // Deduct immediately
  userBalance -= playBet;
  pot += playBet;

  // game.playerHand and game.aiHand are already objects, no JSON.parse needed
  const playerHand = game.playerHand;
  const aiHand = game.aiHand;

  const communityCards = dealCommunityCards(
    game.communityCards || [],
    playerHand,
    aiHand
  );

  const winner = compareHands(playerHand, aiHand, communityCards);
  const result = winner === "player" ? "win" : winner === "dealer" ? "lose" : "tie";

  let winAmount = 0;
  if (result === "win") {
    winAmount = pot;
    userBalance += winAmount;
  }

  // Update DB
  await db.transaction(async (tx) => {
    await tx.update(pokerGames).set({
      pot,
      result,
      communityCards,
      aiHand
    }).where(eq(pokerGames.id, gameId));

    await tx.update(users).set({ balance: userBalance }).where(eq(users.clerkId, userId));
  });

  return new Response(JSON.stringify({
    success: true,
    game: { ...game, pot, result, communityCards, aiHand },
    positions: [
      { player_id: user.id, hand: playerHand },
      { player_id: null, hand: aiHand },
    ],
    result: {
      message: `Hand over. ${result === "win" ? "You won!" : result === "lose" ? "Dealer wins!" : "It's a tie."}`,
      won: result === "win",
      winAmount,
      bet: playBet,
    },
    newBalance: userBalance,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}


    throw new Error("Invalid action");

  } catch (err) {
    console.error("❌ Poker action error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message || "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
