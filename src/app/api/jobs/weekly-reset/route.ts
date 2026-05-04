import { sql } from "@vercel/postgres";

export async function GET() {
  await sql`
    UPDATE users
    SET weekly_wagered = 0,
        weekly_won = 0,
        weekly_profit = 0,
        weekly_wins = 0
  `;
  return Response.json({ ok: true });
}
