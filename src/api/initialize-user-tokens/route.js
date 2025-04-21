async function handler() {
  const session = getSession();

  if (!session?.user?.id) {
    return {
      success: false,
      error: "Utilisateur non authentifié",
    };
  }

  try {
    // Vérifie si l'utilisateur a déjà des tokens
    const checkResult = await sql`
      SELECT * FROM user_tokens 
      WHERE user_id = ${session.user.id}
    `;

    if (checkResult.length === 0) {
      // Crée une nouvelle entrée avec 1000 tokens
      const result = await sql`
        INSERT INTO user_tokens (user_id, balance)
        VALUES (${session.user.id}, 1000)
        RETURNING *
      `;

      return {
        success: true,
        data: result[0],
      };
    }

    // Retourne les tokens existants
    return {
      success: true,
      data: checkResult[0],
    };
  } catch (error) {
    console.error("Error initializing user tokens:", error);
    return {
      success: false,
      error: "Erreur lors de l'initialisation des tokens",
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}