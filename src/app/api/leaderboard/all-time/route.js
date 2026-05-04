import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";

const sortMap = {
  level: "level DESC, total_wagered DESC, id ASC",
  total_wagered: "total_wagered DESC, level DESC, id ASC",
  biggest_win: "biggest_win DESC, total_wagered DESC, id ASC",
  best_streak: "best_streak DESC, level DESC, id ASC",
};

const clampLimit = (value) => Math.min(50, Math.max(20, Number(value) || 20));

export async function GET(request) {
  const { userId } = await auth();
  const { searchParams } = new URL(request.url);
  const category = searchParams.get("category") || "level";
  const orderBy = sortMap[category] || sortMap.level;
  const limit = clampLimit(searchParams.get("limit"));
  const offset = Math.max(0, Number(searchParams.get("offset") || 0));

  const leaderboard = await sql.query(`
    SELECT
      u.clerk_id,
      u.name,
      u.level,
      u.total_wagered,
      u.biggest_win,
      u.best_streak,
      ROW_NUMBER() OVER (ORDER BY ${orderBy})::int AS rank
    FROM users u
    ORDER BY ${orderBy}
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  let me = null;
  if (userId) {
    const mine = await sql.query(`
      SELECT rank, clerk_id, name, level, total_wagered, biggest_win, best_streak
      FROM (
        SELECT
          u.clerk_id,
          u.name,
          u.level,
          u.total_wagered,
          u.biggest_win,
          u.best_streak,
          ROW_NUMBER() OVER (ORDER BY ${orderBy})::int AS rank
        FROM users u
      ) ranked
      WHERE clerk_id = $1
      LIMIT 1
    `, [userId]);
    me = mine.rows[0] ?? null;
  }

  return Response.json({ items: leaderboard.rows, me, category, limit, offset });
}
