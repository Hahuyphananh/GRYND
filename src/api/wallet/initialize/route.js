async function handler() {
  const session = getSession();
  if (!session?.user?.id) {
    return { success: false, error: "User not authenticated" };
  }

  const existingWallet = await sql`
    SELECT * FROM wallet WHERE user_id = ${session.user.id}
  `;

  if (existingWallet.length > 0) {
    return { success: true, wallet: existingWallet[0] };
  }

  const result = await sql.transaction(async (sql) => {
    const newWallet = await sql`
      INSERT INTO wallet (user_id, balance) 
      VALUES (${session.user.id}, 1000) 
      RETURNING *
    `;

    await sql`
      INSERT INTO transactions (user_id, type, amount, status) 
      VALUES (${session.user.id}, 'initial_bonus', 1000, 'completed')
    `;

    return newWallet;
  });

  return { success: true, wallet: result[0] };
}
export async function POST(request) {
  return handler(await request.json());
}