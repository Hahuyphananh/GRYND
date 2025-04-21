async function handler({ hands, initialAmount }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Utilisateur non authentifié" };
  }

  if (
    !hands ||
    !Array.isArray(hands) ||
    hands.length === 0 ||
    !initialAmount ||
    initialAmount <= 0
  ) {
    return { success: false, error: "Paramètres invalides" };
  }

  try {
    const result = await sql.transaction(async (sql) => {
      let totalWinAmount = 0;
      let gamesWon = 0;
      let totalWagered = 0;

      // Calculate totals for all hands
      for (const hand of hands) {
        const handAmount = hand.isDouble ? initialAmount * 2 : initialAmount;
        totalWagered += handAmount;

        if (hand.multiplier > 0) {
          totalWinAmount += handAmount * hand.multiplier;
          gamesWon += 1;
        }
      }

      // Update user tokens with total winnings
      const [tokenResult] = await sql(
        "UPDATE user_tokens SET balance = balance + $1 WHERE user_id = $2 RETURNING balance",
        [totalWinAmount, session.user.id]
      );

      // Update blackjack stats
      await sql(
        `
        INSERT INTO blackjack_stats (
          user_id, games_played, games_won, total_wagered, total_won
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET 
          games_played = blackjack_stats.games_played + $2,
          games_won = blackjack_stats.games_won + $3,
          total_wagered = blackjack_stats.total_wagered + $4,
          total_won = blackjack_stats.total_won + $5`,
        [session.user.id, hands.length, gamesWon, totalWagered, totalWinAmount]
      );

      return tokenResult;
    });

    return {
      success: true,
      data: { newBalance: result.balance },
    };
  } catch (error) {
    return {
      success: false,
      error: "Erreur lors du règlement de la mise",
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}