import { and, eq, sql } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { neonTerritoryMatches, users } from "../../../../db/schema";
import { createInitialState } from "../../../../lib/neonTerritoryEngine";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { gameId } = await req.json();
  if (!gameId) return Response.json({ error: "gameId required" }, { status: 400 });

  const [game] = await db.select().from(neonTerritoryMatches).where(eq(neonTerritoryMatches.id, gameId));
  if (!game || game.status !== "waiting") return Response.json({ error: "Game not available" }, { status: 404 });

  const [deducted] = await db
    .update(users)
    .set({ balance: sql`${users.balance} - ${game.wagerAmount}` })
    .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${game.wagerAmount}`))
    .returning({ id: users.id });

  if (!deducted) return Response.json({ error: "Insufficient balance" }, { status: 400 });

  const liveState = createInitialState(game.player1Id, userId);
  const [updated] = await db
    .update(neonTerritoryMatches)
    .set({ player2Id: userId, status: "active", gameState: liveState })
    .where(eq(neonTerritoryMatches.id, gameId))
    .returning({ id: neonTerritoryMatches.id });

  return Response.json({ success: true, gameId: updated.id });
}
