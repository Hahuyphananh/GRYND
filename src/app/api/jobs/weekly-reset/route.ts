import { sql } from "@vercel/postgres";

export async function GET(request: Request) {
  // Vercel Cron Jobs send a CRON_SECRET header; validate it to prevent
  // unauthorized access. This also ensures weekly data actually resets.
  const authHeader = request.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await sql`
    UPDATE users
    SET weekly_wagered = 0,
        weekly_won = 0,
        weekly_profit = 0,
        weekly_wins = 0
  `;

  await sql`
    UPDATE user_stats
    SET weekly_wagered = 0,
        weekly_won = 0,
        weekly_wins = 0,
        weekly_losses = 0,
        weekly_level_gain = 0,
        weekly_best_streak = 0,
        weekly_biggest_win = 0,
        weekly_win_rate = 0,
        weekly_game_streak = 0,
        updated_at = NOW()
  `;

  // Purge big-wins feed entries older than 7 days so the
  // big-wins chat feed doesn't show stale wins after reset
  await sql`
    DELETE FROM big_wins
    WHERE created_at < NOW() - INTERVAL '7 days'
  `;

  return Response.json({ ok: true, resetAt: new Date().toISOString() });
}
