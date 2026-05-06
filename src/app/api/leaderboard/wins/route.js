import { sql } from "@vercel/postgres";

const clampLimit = (value) => Math.min(50, Math.max(20, Number(value) || 20));

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = clampLimit(searchParams.get("limit"));
  const offset = Math.max(0, Number(searchParams.get("offset") || 0));

  const wins = await sql`
    SELECT id, user_id, username, game, bet_amount, win_amount, multiplier, created_at
    FROM big_wins
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    ORDER BY multiplier DESC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return Response.json({ items: wins.rows, limit, offset });
}
