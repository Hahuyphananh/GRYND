async function handler({ userId }) {
  if (!userId) {
    return { error: "Utilisateur non spécifié" };
  }

  const [game] = await sql`
    SELECT * FROM poker_games 
    WHERE player_id = ${userId}
    AND status = 'active'
    ORDER BY created_at DESC 
    LIMIT 1
  `;

  if (!game) {
    return { game: null };
  }

  const positions = await sql`
    SELECT * FROM poker_player_positions 
    WHERE game_id = ${game.id}
    ORDER BY position
  `;

  return {
    game,
    positions,
  };
}
export async function POST(request) {
  return handler(await request.json());
}