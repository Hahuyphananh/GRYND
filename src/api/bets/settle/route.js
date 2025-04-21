async function handler({ betId, result }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { error: "Unauthorized" };
  }

  try {
    const [bet] = await sql`
      SELECT b.*, s.odds, ut.balance 
      FROM bets b
      JOIN selections s ON b.selection_id = s.id
      JOIN user_tokens ut ON b.user_id = ut.user_id
      WHERE b.id = ${betId} 
      AND b.user_id = ${session.user.id}
      AND b.status = 'pending'
    `;

    if (!bet) {
      return { error: "Bet not found or already settled" };
    }

    const winAmount = result === "won" ? bet.potential_win : 0;
    const newBalance = bet.balance + winAmount;

    const results = await sql.transaction([
      sql`
        UPDATE bets 
        SET status = ${result}, 
            settled_at = CURRENT_TIMESTAMP 
        WHERE id = ${betId}
      `,

      sql`
        UPDATE user_tokens 
        SET balance = ${newBalance}
        WHERE user_id = ${session.user.id}
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
            ELSE ROUND(((wins + ${
              result === "won" ? 1 : 0
            })::numeric / (total_bets + 1) * 100), 2)
          END
        WHERE user_id = ${session.user.id}
      `,
    ]);

    return {
      success: true,
      newBalance,
      result,
    };
  } catch (error) {
    console.error("Error settling bet:", error);
    return { error: "Failed to settle bet" };
  }
}
export async function POST(request) {
  return handler(await request.json());
}