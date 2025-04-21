async function handler({ amount }) {
  const session = getSession();
  if (!session?.user?.id) {
    return { error: "User not authenticated" };
  }

  if (!amount || amount <= 0) {
    return { error: "Invalid bet amount" };
  }

  try {
    const result = await sql.transaction(async (sql) => {
      const [userTokens] = await sql`
        SELECT balance 
        FROM user_tokens 
        WHERE user_id = ${session.user.id}
        FOR UPDATE
      `;

      if (!userTokens || userTokens.balance < amount) {
        throw new Error("Insufficient balance");
      }

      const [updatedTokens] = await sql`
        UPDATE user_tokens 
        SET balance = balance - ${amount}
        WHERE user_id = ${session.user.id}
        RETURNING balance
      `;

      await sql`
        INSERT INTO transactions 
        (user_id, type, amount, balance_after, status)
        VALUES 
        (${session.user.id}, 'blackjack_bet', ${amount}, ${updatedTokens.balance}, 'completed')
      `;

      return {
        newBalance: updatedTokens.balance,
        betAmount: amount,
      };
    });

    return result;
  } catch (error) {
    return { error: error.message };
  }
}
export async function POST(request) {
  return handler(await request.json());
}