import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { parseAndValidateJson } from "../../../../lib/security/validation";

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
      won: { type: "number", required: false, min: 0, max: 1, default: 0 },
      blackjack: { type: "number", required: false, min: 0, max: 1, default: 0 },
      amount: { type: "number", required: true, min: 0, max: 1000000 },
      winAmount: { type: "number", required: true, min: 0, max: 1000000 },
    });

    if (!parsed.ok) return parsed.response;

    const { amount, winAmount } = parsed.data;
    const won = Boolean(parsed.data.won);
    const blackjack = Boolean(parsed.data.blackjack);

    const existingGames = await sql`
      SELECT * FROM blackjack_games 
      WHERE user_id = ${userId}
    `;

    if (existingGames.rows.length === 0) {
      await sql`
        INSERT INTO blackjack_games 
        (user_id, games_played, games_won, blackjacks, total_wagered, total_won)
        VALUES 
        (${userId}, 1, ${won ? 1 : 0}, ${blackjack ? 1 : 0}, ${amount}, ${winAmount})
      `;
    } else {
      await sql`
        UPDATE blackjack_games 
        SET 
          games_played = games_played + 1,
          games_won = games_won + ${won ? 1 : 0},
          blackjacks = blackjacks + ${blackjack ? 1 : 0},
          total_wagered = total_wagered + ${amount},
          total_won = total_won + ${winAmount}
        WHERE user_id = ${userId}
      `;
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error updating blackjack games:", error);
    return new Response(JSON.stringify({ error: "Failed to update blackjack games" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
