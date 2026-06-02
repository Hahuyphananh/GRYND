import { sql } from "@vercel/postgres";

export async function GET(_request: Request) {
  // Vercel Cron Jobs send a CRON_SECRET header; validate it to prevent
  // unauthorized access and data loss.
  const authHeader = _request.headers.get("authorization");
  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && authHeader !== `Bearer ${expectedSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await sql`
    DELETE FROM big_wins
    WHERE created_at < NOW() - INTERVAL '24 hours'
  `;
  return Response.json({ ok: true, deleted: result.rowCount ?? 0 });
}
