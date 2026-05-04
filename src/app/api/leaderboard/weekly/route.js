import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

const clampLimit = (value) => Math.min(50, Math.max(20, Number(value) || 20));

export async function GET(request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  const limit = clampLimit(searchParams.get("limit"));
  const offset = Math.max(0, Number(searchParams.get("offset") || 0));

  const leaderboard = await sql`
    SELECT
      u.clerk_id,
      u.name,
      u.weekly_wagered,
      u.weekly_profit,
      u.weekly_wins,
      ROW_NUMBER() OVER (
        ORDER BY u.weekly_wagered DESC, u.weekly_profit DESC, u.weekly_wins DESC, u.id ASC
      )::int AS rank
    FROM users u
    ORDER BY u.weekly_wagered DESC, u.weekly_profit DESC, u.weekly_wins DESC, u.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  let me = null;
  if (userId) {
    const mine = await sql`
      SELECT rank, clerk_id, name, weekly_wagered, weekly_profit, weekly_wins
      FROM (
        SELECT
          u.clerk_id,
          u.name,
          u.weekly_wagered,
          u.weekly_profit,
          u.weekly_wins,
          ROW_NUMBER() OVER (
            ORDER BY u.weekly_wagered DESC, u.weekly_profit DESC, u.weekly_wins DESC, u.id ASC
          )::int AS rank
        FROM users u
      ) ranked
      WHERE clerk_id = ${userId}
      LIMIT 1
    `;
    me = mine.rows[0] ?? null;
  }

  return Response.json({ items: leaderboard.rows, me, limit, offset });
}
