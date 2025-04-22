async function handler() {
  const session = getSession();

  if (!session?.user?.id) {
    return { error: "Non authentifié" };
  }

  const wallets = await sql`
    INSERT INTO wallets (user_id)
    VALUES (${session.user.id})
    RETURNING *
  `;

  return wallets[0];
}
export async function POST(request) {
  return handler(await request.json());
}