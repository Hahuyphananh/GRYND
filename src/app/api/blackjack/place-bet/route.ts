import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db";
import { users, } from "../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: Request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();
  const amount = body?.amount;

  if (!amount || amount <= 0) {
    return new Response(JSON.stringify({ success: false, error: "Invalid amount" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!user || user.balance < amount) {
      return new Response(JSON.stringify({ success: false, error: "Insufficient balance" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const newBalance = user.balance - amount;

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ balance: newBalance })
        .where(eq(users.clerkId, userId));

      await tx.insert(transactions).values({
        userId: user.id,
        type: "blackjack_bet",
        amount,
        balanceAfter: newBalance,
        status: "completed",
      });
    });

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          newBalance,
          betAmount: amount,
          action: "bet placed",
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("❌ Blackjack bet error:", err);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
