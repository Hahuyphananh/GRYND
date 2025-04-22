async function handler({ gameId }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { error: "Unauthorized" };
  }

  try {
    const [game] = await sql`
      SELECT * FROM poker_games 
      WHERE id = ${gameId} 
      AND player_id = ${session.user.id}
      AND status != 'ended'
    `;

    if (!game) {
      return { error: "Game not found or already ended" };
    }

    const positions = await sql`
      SELECT * FROM poker_player_positions
      WHERE game_id = ${gameId}
    `;

    await sql.transaction(async (sql) => {
      await sql`
        UPDATE poker_games
        SET status = 'ended',
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${gameId}
      `;

      for (const position of positions) {
        if (position.stack > 0) {
          await sql`
            UPDATE user_tokens
            SET balance = balance + ${position.stack}
            WHERE user_id = ${position.player_id}
          `;
        }
      }

      await sql`
        DELETE FROM poker_player_positions
        WHERE game_id = ${gameId}
      `;
    });

    return { success: true };
  } catch (error) {
    console.error("Error ending poker game:", error);
    return { error: "Failed to end game" };
  }
}
export async function POST(request) {
  return handler(await request.json());
}