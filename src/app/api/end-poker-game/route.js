import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  const { userId } = auth();

  if (!userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { gameId } = await request.json();

  if (!gameId) {
    return new Response(JSON.stringify({ error: "Missing game ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { rows: games } = await sql`
      SELECT * FROM poker_games 
      WHERE id = ${gameId} 
      AND player_id = ${userId}
      AND status != 'ended'
    `;

    const game = games[0];

    if (!game) {
      return new Response(JSON.stringify({ error: "Game not found or already ended" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { rows: positions } = await sql`
      SELECT * FROM poker_player_positions
      WHERE game_id = ${gameId}
    `;

    await sql.begin(async (tx) => {
      await tx`
        UPDATE poker_games
        SET status = 'ended',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${gameId}
      `;

      for (const position of positions) {
        if (position.stack > 0) {
          await tx`
            UPDATE user_tokens
            SET balance = balance + ${position.stack}
            WHERE user_id = ${position.player_id}
          `;
        }
      }

      await tx`
        DELETE FROM poker_player_positions
        WHERE game_id = ${gameId}
      `;
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("❌ Error ending poker game:", err);
    return new Response(JSON.stringify({ error: "Failed to end game" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
