async function handler() {
  const session = getSession();

  if (!session?.user?.id) {
    return { error: "Non authentifié" };
  }

  const wallets = await sql`
    SELECT * FROM wallets 
    WHERE user_id = ${session.user.id}
  `;

  return wallets[0] || null;
}
export async function POST(request) {
  return handler(await request.json());
}