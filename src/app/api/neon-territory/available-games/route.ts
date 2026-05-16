import { desc, eq } from "drizzle-orm";
import { db } from "../../../../db";
import { neonTerritoryMatches } from "../../../../db/schema";

export async function GET() {
  const games = await db
    .select({
      id: neonTerritoryMatches.id,
      player1Id: neonTerritoryMatches.player1Id,
      wagerAmount: neonTerritoryMatches.wagerAmount,
      tokenType: neonTerritoryMatches.tokenType,
      createdAt: neonTerritoryMatches.createdAt,
    })
    .from(neonTerritoryMatches)
    .where(eq(neonTerritoryMatches.status, "waiting"))
    .orderBy(desc(neonTerritoryMatches.createdAt));

  return Response.json({ success: true, games });
}
