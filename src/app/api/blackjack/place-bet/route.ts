import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users, blackjackGames } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();
  const amount = parseFloat(body?.amount);

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

    if (!user || parseFloat(user.balance) < amount) {
      return new Response(JSON.stringify({ success: false, error: "Insufficient balance" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const newBalance = parseFloat(user.balance) - amount;

    await db.transaction(async (tx) => {
      // Update user's balance
     await tx.update(users).set({
  [users.balance.name]: newBalance, // if you want to dynamically reference it
}).where(eq(users.clerkId, userId));


      // Insert blackjack game record
 await tx.insert(blackjackGames).values({
  userId: user.id,
  betAmount: amount.toString(), // 👈 numeric expects string!
  result: "pending",
  payout: "0",                  // 👈 also a string!
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
    });
  } catch (err) {
    console.error("❌ Blackjack bet error:", err);
    return new Response(JSON.stringify({ success: false, error: "Server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
