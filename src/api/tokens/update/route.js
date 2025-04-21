async function handler({ amount }) {
  try {
    if (!amount) {
      return {
        success: false,
        error: "Le montant est requis",
      };
    }

    const session = getSession();
    if (!session?.user?.id) {
      return {
        success: false,
        error: "Utilisateur non authentifié",
      };
    }

    // Récupérer le solde actuel
    const result = await sql`
      SELECT balance 
      FROM user_tokens 
      WHERE user_id = ${session.user.id}
    `;

    if (result.length === 0) {
      return {
        success: false,
        error: "Compte de tokens non trouvé",
      };
    }

    // Mettre à jour le solde
    const updateResult = await sql`
      UPDATE user_tokens 
      SET balance = balance + ${amount}
      WHERE user_id = ${session.user.id}
      RETURNING balance
    `;

    // Enregistrer la transaction
    await sql`
      INSERT INTO transactions (
        user_id,
        type,
        amount,
        balance_after,
        status
      ) VALUES (
        ${session.user.id},
        ${amount > 0 ? "win" : "loss"},
        ${Math.abs(amount)},
        ${updateResult[0].balance},
        'completed'
      )
    `;

    return {
      success: true,
      data: {
        balance: updateResult[0].balance,
      },
    };
  } catch (error) {
    console.error("Error updating token balance:", error);
    return {
      success: false,
      error: "Erreur lors de la mise à jour du solde",
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}