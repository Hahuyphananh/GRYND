import { auth } from "@clerk/nextjs/server";
import { getNeonSql } from "../../../../db/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const sql = getNeonSql();
  try {
    // Prevent 415 issues on Vercel by safely accepting requests
    // even when frontend sends no body or wrong content-type.
    try {
      const contentType = req.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        await req.text(); // consume body safely if present
      }
    } catch {
      // ignore body parsing issues
    }

    const { userId } = await auth();

    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const rows = await sql`
  INSERT INTO user_presence (
    clerk_id,
    last_seen,
    status,
    current_game_id,
    updated_at
  )
  VALUES (
    ${userId},
    NOW(),
    'online'::presence_status,
    NULL,
    NOW()
  )
  ON CONFLICT (clerk_id)
  DO UPDATE SET
    last_seen = NOW(),
    status = CASE
      WHEN user_presence.status = 'in_game'::presence_status
      THEN 'in_game'::presence_status
      ELSE 'online'::presence_status
    END,
    updated_at = NOW()
  WHERE user_presence.updated_at < NOW() - INTERVAL '4 minutes'
  RETURNING
    clerk_id,
    status,
    current_game_id,
    last_seen,
    updated_at
`;

    // The WHERE on the DO UPDATE makes the write conditional: when the row
    // was touched in the last 4 minutes (an in-game client beating every 2
    // minutes, or another tab's heartbeat), the UPSERT is a no-op — zero
    // rows updated, no WAL write. Only genuinely stale rows pay the write
    // cost, which is the entire point of the keep-alive. Heartbeats still
    // fire on the client's 5/10-minute cadence; this just stops redundant
    // writes when something fresher already exists. The client ignores the
    // returned row, so an empty RETURNING is safe.

    return Response.json({
      success: true,
      data: rows[0] || null,
    });
  } catch (error) {
    console.error("PRESENCE HEARTBEAT ERROR:", error);

    return Response.json(
      {
        success: false,
        error: "Failed to update heartbeat",
      },
      { status: 500 },
    );
  }
}
