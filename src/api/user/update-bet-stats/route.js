async function handler({ userId, betAmount, isWin }) {
  if (!userId) {
    return { error: "User ID is required" };
  }

  try {
    const result = await sql.transaction([
      // Get current stats
      sql`
        SELECT * FROM user_stats 
        WHERE user_id = ${userId}
      `,
      // Update stats
      sql`
        INSERT INTO user_stats (
          user_id, 
          total_bets,
          wins,
          losses,
          total_wagered,
          total_won,
          win_rate
        )
        VALUES (
          ${userId},
          1,
          ${isWin ? 1 : 0},
          ${isWin ? 0 : 1},
          ${betAmount},
          ${isWin ? betAmount : 0},
          ${isWin ? 100 : 0}
        )
        ON CONFLICT (user_id)
        DO UPDATE SET
          total_bets = user_stats.total_bets + 1,
          wins = user_stats.wins + ${isWin ? 1 : 0},
          losses = user_stats.losses + ${isWin ? 0 : 1},
          total_wagered = user_stats.total_wagered + ${betAmount},
          total_won = user_stats.total_won + ${isWin ? betAmount : 0},
          win_rate = ROUND(
            (user_stats.wins + ${isWin ? 1 : 0})::numeric / 
            (user_stats.total_bets + 1) * 100, 
            2
          )
        RETURNING *
      `,
    ]);

    const updatedStats = result[1][0];
    return { success: true, stats: updatedStats };
  } catch (error) {
    return { error: "Failed to update user stats" };
  }
}
export async function POST(request) {
  return handler(await request.json());
}