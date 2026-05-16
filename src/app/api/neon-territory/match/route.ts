import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { neonTerritoryMatches } from "../../../../db/schema";
import { createInitialState } from "../../../../lib/neonTerritoryEngine";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const opponentId = body?.opponentId ?? "ai-bot";
  const wagerAmount = Number(body?.wagerAmount ?? 0);
  const tokenType = body?.tokenType ?? "SC";

  const gameState = createInitialState(userId, opponentId);

  const [created] = await db
    .insert(neonTerritoryMatches)
    .values({
      player1Id: userId,
      player2Id: opponentId,
      wagerAmount,
      tokenType,
      gameState,
      turnNumber: 0,
      status: "active",
    })
    .returning({ id: neonTerritoryMatches.id, gameState: neonTerritoryMatches.gameState });

  return Response.json(created, { status: 201 });
}
