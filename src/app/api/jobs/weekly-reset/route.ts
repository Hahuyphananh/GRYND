import { sql } from "@vercel/postgres";

export async function GET() {
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
        updated_at = NOW()
  `;

  return Response.json({ ok: true });
}
