async function handler() {
  const userStats = await sql`
    SELECT 
      us.*,
      au.name as username,
      au.image as user_image
    FROM user_stats us
    JOIN auth_users au ON us.user_id = au.id
    ORDER BY total_won DESC, win_rate DESC
    LIMIT 100
  `;

  return { stats: userStats };
}
export async function POST(request) {
  return handler(await request.json());
}