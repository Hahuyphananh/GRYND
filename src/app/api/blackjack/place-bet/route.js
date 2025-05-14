import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = await auth();

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
    const { rows } = await sql`
      SELECT id, balance FROM users WHERE clerk_id = ${userId}
    `;
    const user = rows[0];

    if (!user || user.balance < amount) {
      return new Response(JSON.stringify({ success: false, error: "Insufficient balance" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { rows: updatedRows } = await sql`
      UPDATE users SET balance = balance - ${amount}
      WHERE clerk_id = ${userId}
      RETURNING balance
    `;
    const updatedUser = updatedRows[0];

    await sql`
      INSERT INTO transactions (user_id, type, amount, balance_after, status)
      VALUES (${user.id}, 'blackjack_bet', ${amount}, ${updatedUser.balance}, 'completed')
    `;

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          newBalance: updatedUser.balance,
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

    return new Response(
      JSON.stringify({
        success: false,
        error: "Server error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
