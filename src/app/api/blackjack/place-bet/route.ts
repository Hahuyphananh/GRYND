import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = await request.json();
  const amount = parseFloat(body?.amount);

  if (!amount || amount <= 0) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid amount" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const [updated] = await db
      .update(users)
      .set({ balance: sql`${users.balance} - ${amount}` })
      .where(
        sql`${users.clerkId} = ${userId} AND ${users.balance} >= ${amount}`,
      )
      .returning({ balance: users.balance });

    if (!updated) {
      return new Response(
        JSON.stringify({ success: false, error: "Insufficient balance" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          deducted: amount,
          newBalance: Number(updated.balance),
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("❌ Blackjack game error:", err);
    return new Response(
      JSON.stringify({ success: false, error: "Server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
