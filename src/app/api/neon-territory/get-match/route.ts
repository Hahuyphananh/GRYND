import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { neonTerritoryMatches } from "../../../../db/schema";
import { normalizeGameState, type NeonGameState } from "../../../../lib/neonTerritoryEngine";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const matchId = searchParams.get("matchId");
  if (!matchId) return Response.json({ error: "matchId required" }, { status: 400 });

  const [match] = await db.select().from(neonTerritoryMatches).where(eq(neonTerritoryMatches.id, matchId));
  if (!match) return Response.json({ error: "Match not found" }, { status: 404 });

  return Response.json({
    success: true,
    match: { ...match, gameState: normalizeGameState(match.gameState as NeonGameState) },
  });
}
