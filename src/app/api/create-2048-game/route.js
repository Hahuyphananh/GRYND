import { v4 as uuidv4 } from "uuid";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";

// Ensure global persistence across hot reloads (dev mode)
const globalGames = globalThis;
if (!globalGames.games) globalGames.games = {};
const games = globalGames.games;

/**
 * POST /api/create-2048-game
 * Creates a new 2048 game session with a bet amount and deducts tokens.
 */
export async function POST(request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { betAmount } = body;

    if (typeof betAmount !== "number" || betAmount <= 0) {
      return new Response(JSON.stringify({ error: "Invalid bet amount" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 🔹 Fetch the user from the database
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const balance = parseFloat(user.balance);
    if (balance < betAmount) {
      return new Response(JSON.stringify({ error: "Insufficient balance" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 🔹 Deduct tokens
    const newBalance = balance - betAmount;
    await db.update(users)
      .set({ balance: newBalance.toFixed(2) })
      .where(eq(users.clerkId, userId));

    // 🔹 Create game session in memory
    const gameId = uuidv4();
    games[gameId] = {
      betAmount,
      players: [userId],
      boardStates: {},
      scores: {},
    };

    return new Response(JSON.stringify({ gameId, newBalance }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("❌ Failed to create 2048 game:", err);
    return new Response(JSON.stringify({ error: "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
