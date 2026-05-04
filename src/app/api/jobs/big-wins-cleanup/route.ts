import { sql } from "@vercel/postgres";

export async function GET() {
  const result = await sql`
    DELETE FROM big_wins
    WHERE created_at < NOW() - INTERVAL '24 hours'
  `;
  return Response.json({ ok: true, deleted: result.rowCount ?? 0 });
}
