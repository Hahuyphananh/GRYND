import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, blackjackGames } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { parseAndValidateJson } from "../../../../lib/security/validation";

const RESULT_MAP = new Set(["win", "lose", "push", "bust"]);

export async function POST(request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const parsed = await parseAndValidateJson(request, {
      result: { type: "string", required: true },
      amount: { type: "number", required: true, min: 0, max: 1000000 },
      payout: { type: "number", required: true, min: 0, max: 1000000 },
      blackjack: { type: "number", required: false, min: 0, max: 1, default: 0 },
    });

    if (!parsed.ok) return parsed.response;

    const result = String(parsed.data.result);
    if (!RESULT_MAP.has(result)) {
      return new Response(JSON.stringify({ error: "Invalid result" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const amount = Number(parsed.data.amount);
    const payout = Number(parsed.data.payout);

    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const [updatedUser] = await db
      .update(users)
      .set({ balance: sql`${users.balance} + ${payout}` })
      .where(eq(users.id, user.id))
      .returning({ balance: users.balance });

    await db.insert(blackjackGames).values({
      userId: user.id,
      betAmount: amount.toFixed(2),
      result: result === "push" ? "draw" : (result === "win" ? "win" : "lose"),
      payout: payout.toFixed(2),
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: { newBalance: Number(updatedUser?.balance ?? user.balance), payout },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error updating blackjack game:", error);
    return new Response(JSON.stringify({ error: "Failed to settle blackjack game" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
