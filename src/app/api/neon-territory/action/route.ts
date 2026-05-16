import { and, eq } from "drizzle-orm";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/db";
import { neonTerritoryActions, neonTerritoryMatches } from "@/db/schema";
import { pickAiAction, resolveTurn, validateAction, type MatchAction, type NeonGameState } from "@/lib/neonTerritoryEngine";

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json();

  const [match] = await db.select().from(neonTerritoryMatches).where(eq(neonTerritoryMatches.id, body.matchId));
  if (!match) return Response.json({ error: "Match not found" }, { status: 404 });

  const state = match.gameState as NeonGameState;
  const player = match.player1Id === userId ? "player1" : match.player2Id === userId ? "player2" : null;
  if (!player) return Response.json({ error: "Not in match" }, { status: 403 });

  const action: MatchAction = { userId, player, turnNumber: state.turnNumber, targetX: body.targetX, targetY: body.targetY };
  const valid = validateAction(state, action);
  if (!valid.valid) return Response.json({ error: valid.error }, { status: 400 });

  await db.insert(neonTerritoryActions).values({ matchId: match.id, userId, turnNumber: state.turnNumber, targetX: body.targetX, targetY: body.targetY });

  const actions = await db.select().from(neonTerritoryActions).where(and(eq(neonTerritoryActions.matchId, match.id), eq(neonTerritoryActions.turnNumber, state.turnNumber)));
  const mapped: MatchAction[] = actions.map((a) => ({ userId: a.userId, player: a.userId === match.player1Id ? "player1" : "player2", turnNumber: a.turnNumber, targetX: a.targetX, targetY: a.targetY }));

  if (match.player2Id === "ai-bot" && mapped.length === 1) {
    const aiAction = pickAiAction(state, "player2", "ai-bot");
    if (aiAction) mapped.push(aiAction);
  }

  if (mapped.length < 2 && match.player2Id !== "ai-bot") {
    return Response.json({ ok: true, waiting: true });
  }

  const nextState = resolveTurn(state, mapped);
  await db
    .update(neonTerritoryMatches)
    .set({ gameState: nextState, turnNumber: nextState.turnNumber, status: nextState.status })
    .where(eq(neonTerritoryMatches.id, match.id));

  await db.delete(neonTerritoryActions).where(and(eq(neonTerritoryActions.matchId, match.id), eq(neonTerritoryActions.turnNumber, state.turnNumber)));

  return Response.json({ ok: true, state: nextState });
}
