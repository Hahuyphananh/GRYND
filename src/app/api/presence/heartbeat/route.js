import { auth } from "@clerk/nextjs/server";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sql = neon(process.env.DATABASE_URL);

export async function POST(req) {
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
        { status: 401 }
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
  RETURNING
    clerk_id,
    status,
    current_game_id,
    last_seen,
    updated_at
`;

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
      { status: 500 }
    );
  }
}