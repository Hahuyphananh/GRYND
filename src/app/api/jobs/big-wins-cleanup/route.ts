import { sql } from "../../../../db/sql";
import { verifyCronRequest } from "../../../../lib/security/cronAuth";

export async function GET(request: Request) {
  // Authenticate cron request before performing global state changes
  const authError = verifyCronRequest(request);
  if (authError) return authError;

  const result = await sql`
    DELETE FROM big_wins
    WHERE created_at < NOW() - INTERVAL '24 hours'
  `;
  return Response.json({ ok: true, deleted: result.rowCount ?? 0 });
}
