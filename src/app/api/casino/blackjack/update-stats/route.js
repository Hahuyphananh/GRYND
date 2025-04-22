async function handler({ won, blackjack, wagered, wonAmount }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Utilisateur non authentifié" };
  }

  if (typeof wagered !== "number" || typeof wonAmount !== "number") {
    return { success: false, error: "Montants invalides" };
  }

  try {
    await sql`
      INSERT INTO blackjack_stats (
        user_id, 
        games_played,
        games_won,
        blackjacks,
        total_wagered,
        total_won
      )
      VALUES (
        ${session.user.id},
        1,
        ${won ? 1 : 0},
        ${blackjack ? 1 : 0},
        ${wagered},
        ${wonAmount}
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        games_played = blackjack_stats.games_played + 1,
        games_won = blackjack_stats.games_won + ${won ? 1 : 0},
        blackjacks = blackjack_stats.blackjacks + ${blackjack ? 1 : 0},
        total_wagered = blackjack_stats.total_wagered + ${wagered},
        total_won = blackjack_stats.total_won + ${wonAmount}
    `;

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: "Erreur lors de la mise à jour des statistiques",
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}