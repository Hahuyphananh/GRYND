async function handler({ selectionId, amount }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Non authentifié" };
  }

  if (!selectionId || !amount) {
    return { success: false, error: "Paramètres manquants" };
  }

  try {
    return await sql.transaction(async (sql) => {
      // Vérifie le solde des tokens
      const tokens = await sql`
        SELECT * FROM user_tokens 
        WHERE user_id = ${session.user.id} 
        FOR UPDATE
      `;

      if (!tokens.length || tokens[0].balance < amount) {
        return { success: false, error: "Solde insuffisant" };
      }

      // Vérifie que la sélection existe et est valide
      const selections = await sql`
        SELECT s.*, m.status as market_status, e.status as event_status 
        FROM selections s
        JOIN markets m ON s.market_id = m.id
        JOIN events e ON m.event_id = e.id
        WHERE s.id = ${selectionId}
        AND s.status = 'active'
        AND m.status = 'active'
        AND e.status = 'scheduled'
      `;

      if (!selections.length) {
        return {
          success: false,
          error: "Sélection invalide ou non disponible",
        };
      }

      const selection = selections[0];
      const potentialWin = amount * selection.odds;

      // Crée le pari
      const [bet] = await sql`
        INSERT INTO bets (
          user_id, 
          selection_id, 
          amount, 
          potential_win
        ) 
        VALUES (
          ${session.user.id}, 
          ${selectionId}, 
          ${amount}, 
          ${potentialWin}
        ) 
        RETURNING *
      `;

      // Met à jour le solde des tokens
      await sql`
        UPDATE user_tokens 
        SET balance = balance - ${amount} 
        WHERE user_id = ${session.user.id}
      `;

      // Enregistre la transaction
      await sql`
        INSERT INTO transactions (
          user_id, 
          type, 
          amount, 
          balance_after, 
          status
        ) 
        VALUES (
          ${session.user.id}, 
          'bet', 
          ${amount}, 
          ${tokens[0].balance - amount}, 
          'completed'
        )
      `;

      // Met à jour les statistiques de l'utilisateur
      const statsResponse = await fetch("/api/user/update-bet-stats", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: session.user.id,
          betAmount: amount,
          isWin: false, // Le pari vient d'être placé, donc pas encore gagné
        }),
      });

      if (!statsResponse.ok) {
        console.error("Failed to update user stats");
      }

      return {
        success: true,
        data: {
          bet,
          newBalance: tokens[0].balance - amount,
        },
      };
    });
  } catch (error) {
    console.error("Error placing bet:", error);
    return {
      success: false,
      error: "Une erreur est survenue lors du placement du pari",
    };
  }
}
export async function POST(request) {
  return handler(await request.json());
}