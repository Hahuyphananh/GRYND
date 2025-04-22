async function handler({ userId, won, blackjack, amount, winAmount }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { error: "Unauthorized" };
  }

  try {
    // First check if stats exist for user
    const existingStats = await sql`
      SELECT * FROM blackjack_stats 
      WHERE user_id = ${session.user.id}
    `;

    if (existingStats.length === 0) {
      // Create initial stats
      await sql`
        INSERT INTO blackjack_stats 
        (user_id, games_played, games_won, blackjacks, total_wagered, total_won)
        VALUES 
        (${session.user.id}, 1, ${won ? 1 : 0}, ${
        blackjack ? 1 : 0
      }, ${amount}, ${winAmount})
      `;
    } else {
      // Update existing stats
      await sql`
        UPDATE blackjack_stats 
        SET 
          games_played = games_played + 1,
          games_won = games_won + ${won ? 1 : 0},
          blackjacks = blackjacks + ${blackjack ? 1 : 0},
          total_wagered = total_wagered + ${amount},
          total_won = total_won + ${winAmount}
        WHERE user_id = ${session.user.id}
      `;
    }

    return { success: true };
  } catch (error) {
    return { error: "Failed to update blackjack stats" };
  }
}
export async function POST(request) {
  return handler(await request.json());
}