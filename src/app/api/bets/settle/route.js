import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

async function handler({ betId, result }) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const [bet] = await sql`
      SELECT b.*, s.odds, ut.balance 
      FROM bets b
      JOIN selections s ON b.selection_id = s.id
      JOIN user_tokens ut ON b.user_id = ut.user_id
      WHERE b.id = ${betId} 
      AND b.user_id = ${userId}
      AND b.status = 'pending'
    `;

    if (!bet) {
      return new Response(
        JSON.stringify({ error: "Bet not found or already settled" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const winAmount = result === "won" ? bet.potential_win : 0;
    const newBalance = bet.balance + winAmount;

    await sql.transaction([
      sql`
        UPDATE bets 
        SET status = ${result}, 
            settled_at = CURRENT_TIMESTAMP 
        WHERE id = ${betId}
      `,
      sql`
        UPDATE user_tokens 
        SET balance = ${newBalance}
        WHERE user_id = ${userId}
      `,
      sql`
        UPDATE user_stats 
        SET 
          total_bets = total_bets + 1,
          wins = wins + ${result === "won" ? 1 : 0},
          losses = losses + ${result === "lost" ? 1 : 0},
          total_wagered = total_wagered + ${bet.amount},
          total_won = total_won + ${winAmount},
          win_rate = CASE 
            WHEN (wins + ${result === "won" ? 1 : 0}) = 0 THEN 0
            ELSE ROUND(((wins + ${result === "won" ? 1 : 0})::numeric / (total_bets + 1) * 100), 2)
          END
        WHERE user_id = ${userId}
      `,
    ]);

    return new Response(
      JSON.stringify({
        success: true,
        newBalance,
        result,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error settling bet:", error);
    return new Response(
      JSON.stringify({ error: "Failed to settle bet" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

export async function POST(request) {
  const body = await request.json();
  return handler(body);
}
