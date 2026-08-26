import { auth } from "@clerk/nextjs/server";
import { sql } from "../../../../db/sql";
import { parseAndValidateJson } from "../../../../lib/security/validation";

export async function POST(request) {
  const { userId } = await auth();
  if (!userId)
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 401 },
    );

  const parsed = await parseAndValidateJson(request, {
    gameKey: { type: "string", required: true, minLength: 2, maxLength: 80 },
    gameId: { type: "number", required: true },
    targetClerkId: {
      type: "string",
      required: true,
      minLength: 2,
      maxLength: 255,
    },
  });
  if (!parsed.ok) return parsed.response;

  const { gameKey, gameId, targetClerkId } = parsed.data;
  const normalizedGameKey = String(gameKey || "")
    .toLowerCase()
    .trim();
  const allowedGameKeys = new Set(["chess", "connect-four", "hex-duel", "poker"]);
  if (!allowedGameKeys.has(normalizedGameKey)) {
    return new Response(
      JSON.stringify({ success: false, error: "Unsupported gameKey" }),
      { status: 400 },
    );
  }

  await sql`
    INSERT INTO spectator_presence (spectator_clerk_id, target_clerk_id, game_key, game_id, last_seen_at)
    VALUES (${userId}, ${targetClerkId}, ${normalizedGameKey}, ${Number(gameId)}, NOW())
    ON CONFLICT (spectator_clerk_id, target_clerk_id, game_key, game_id)
    DO UPDATE SET last_seen_at = NOW()
  `;

  await sql`DELETE FROM spectator_presence WHERE last_seen_at < NOW() - INTERVAL '20 seconds'`;

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
