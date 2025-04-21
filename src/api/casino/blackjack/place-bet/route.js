async function handler({ amount, action = "initial" }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Utilisateur non authentifié" };
  }

  if (!amount || amount <= 0) {
    return { success: false, error: "Mise invalide" };
  }

  const deductAmount = action === "double" ? amount : amount;

  try {
    const result = await sql.transaction(async (sql) => {
      const tokens = await sql(
        "SELECT balance FROM user_tokens WHERE user_id = $1 FOR UPDATE",
        [session.user.id]
      );

      if (tokens.length === 0 || tokens[0].balance < deductAmount) {
        throw new Error("Solde insuffisant");
      }

      await sql(
        "UPDATE user_tokens SET balance = balance - $1 WHERE user_id = $2",
        [deductAmount, session.user.id]
      );

      return {
        newBalance: tokens[0].balance - deductAmount,
        betAmount: action === "double" ? amount * 2 : amount,
      };
    });

    return {
      success: true,
      data: {
        newBalance: result.newBalance,
        betAmount: result.betAmount,
        action,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Erreur lors du placement de la mise",
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}