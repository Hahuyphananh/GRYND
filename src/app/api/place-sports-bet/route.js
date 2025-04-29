import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

export async function POST(req) {
  const { userId } = auth();
  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  try {
    const { eventId, betAmount, choice, odds } = await req.json();

    if (!eventId || !betAmount || !choice || !odds) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400,
      });
    }

    // Check user balance
    const balanceResult = await sql`
      SELECT balance FROM user_tokens WHERE user_id = ${userId}
    `;

    const userBalance = parseFloat(balanceResult.rows[0]?.balance ?? 0);
    if (userBalance < betAmount) {
      return new Response(JSON.stringify({ error: "Insufficient balance" }), {
        status: 400,
      });
    }

    // Insert bet
    await sql`
      INSERT INTO sports_bets (user_id, event_id, bet_amount, choice, odds)
      VALUES (${userId}, ${eventId}, ${betAmount}, ${choice}, ${odds})
    `;

    // Deduct balance
    const newBalance = userBalance - betAmount;
    await sql`
      UPDATE user_tokens SET balance = ${newBalance}
      WHERE user_id = ${userId}
    `;

    return new Response(
      JSON.stringify({ success: true, newBalance }),
      { status: 200 }
    );
  } catch (error) {
    console.error("Error placing sports bet:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
    });
  }
}
