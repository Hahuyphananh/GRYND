async function handler() {
  const session = getSession();

  if (!session?.user?.id) {
    return { error: "Unauthorized" };
  }

  const userId = session.user.id;

  try {
    // Vérifie si l'utilisateur a déjà des tokens
    const existingTokens = await sql`
      SELECT id FROM user_tokens WHERE user_id = ${userId}
    `;

    if (existingTokens.length === 0) {
      // Si les tokens n'existent pas, les créer
      const [result] = await sql`
        INSERT INTO user_tokens (user_id, balance)
        VALUES (${userId}, 1000.00)
        RETURNING balance
      `;
      return { balance: result.balance };
    }

    // Si les tokens existent, les réinitialiser
    const [result] = await sql`
      UPDATE user_tokens 
      SET balance = 1000.00
      WHERE user_id = ${userId}
      RETURNING balance
    `;

    return { balance: result.balance };
  } catch (error) {
    console.error("Error resetting tokens:", error);
    return { error: "Erreur lors de la réinitialisation des tokens" };
  }
}
export async function POST(request) {
  return handler(await request.json());
}