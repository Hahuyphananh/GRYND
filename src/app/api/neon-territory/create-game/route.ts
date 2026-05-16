import { and, eq, sql } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { neonTerritoryMatches, users } from "../../../../db/schema";
import { createInitialState } from "../../../../lib/neonTerritoryEngine";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();
  const wagerAmount = Number(body?.wagerAmount ?? 0);
  if (!Number.isFinite(wagerAmount) || wagerAmount <= 0) {
    return Response.json({ error: "Invalid wager amount" }, { status: 400 });
  }

  const [deducted] = await db
    .update(users)
    .set({ balance: sql`${users.balance} - ${wagerAmount}` })
    .where(and(eq(users.clerkId, userId), sql`${users.balance} >= ${wagerAmount}`))
    .returning({ id: users.id });

  if (!deducted) return Response.json({ error: "Insufficient balance" }, { status: 400 });

  const [created] = await db
    .insert(neonTerritoryMatches)
    .values({
      player1Id: userId,
      player2Id: "pending-player",
      wagerAmount,
      tokenType: "SC",
      gameState: createInitialState(userId, "pending-player"),
      turnNumber: 0,
      status: "waiting",
    })
    .returning({ id: neonTerritoryMatches.id });

  return Response.json({ success: true, gameId: created.id });
}
