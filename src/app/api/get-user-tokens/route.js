  async function handler() {
  const session = getSession();

  if (!session?.user?.id) {
    return {
      success: false,
      error: "Utilisateur non authentifié",
    };
  }

  try {
    const result = await sql`
      SELECT * FROM user_tokens 
      WHERE user_id = ${session.user.id}
    `;

    if (result.length === 0) {
      return {
        success: false,
        error: "Aucun token trouvé pour cet utilisateur",
      };
    }

    return {
      success: true,
      data: result[0],
    };
  } catch (error) {
    console.error("Error fetching user tokens:", error);
    return {
      success: false,
      error: "Erreur lors de la récupération des tokens",
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}