import { auth } from "@clerk/nextjs/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames, users } from "../../../../../db/schema";

/**
 * GET /api/hex-duel/multiplayer/spectate?gameId=...&afterId=...
 * Returns game metadata + all actions for a spectator to reconstruct the game state.
 * Unlike the regular actions endpoint, this does NOT require the caller to be a player.
 */
export async function GET(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const gameId = Number(searchParams.get("gameId"));
    const afterId = Number(searchParams.get("afterId")) || 0;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    // Fetch game metadata with player names
    const [game] = await db
      .select({
        id: hexDuelGames.id,
        status: hexDuelGames.status,
        player1Id: hexDuelGames.player1Id,
        player2Id: hexDuelGames.player2Id,
        wagerAmount: hexDuelGames.wagerAmount,
        player1Name: users.name,
      })
      .from(hexDuelGames)
      .leftJoin(users, eq(users.clerkId, hexDuelGames.player1Id))
      .where(eq(hexDuelGames.id, gameId))
      .limit(1);

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Only allow spectating games that are in progress
    const validStatuses = ["in_progress", "turn_player1", "turn_player2"];
    if (!validStatuses.includes(game.status)) {
      return NextResponse.json(
        { success: false, error: "Game is not currently in progress" },
        { status: 400 },
      );
    }

    // Fetch player2 name if they exist
    let player2Name: string | null = null;
    if (game.player2Id) {
      const [p2] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.clerkId, game.player2Id))
        .limit(1);
      player2Name = p2?.name || null;
    }

    const currentTurn = game.status === "turn_player1" ? "player1" : game.status === "turn_player2" ? "player2" : "player1";

    // Fetch ALL actions (not filtered by userId since spectator is not a player)
    const conditions = [eq(hexDuelActions.gameId, gameId)];
    if (afterId > 0) {
      conditions.push(gt(hexDuelActions.id, afterId));
    }

    const actions = await db
      .select()
      .from(hexDuelActions)
      .where(and(...conditions))
      .orderBy(sql`${hexDuelActions.id} ASC`)
      .limit(100);

    const maxId = actions.length > 0 ? Math.max(...actions.map((a) => a.id)) : afterId;

    return NextResponse.json({
      success: true,
      game: {
        id: game.id,
        status: game.status,
        currentTurn,
        player1Id: game.player1Id,
        player2Id: game.player2Id,
        wagerAmount: game.wagerAmount,
        player1Name: game.player1Name || "Player 1",
        player2Name: player2Name || "Player 2",
      },
      actions: actions.map((a) => ({
        id: a.id,
        userId: a.userId,
        actionType: a.actionType,
        sourceKey: a.sourceKey,
        targetKey: a.targetKey,
        troopCount: a.troopCount,
        createdAt: a.createdAt,
      })),
      latestActionId: maxId,
    });
  } catch (error: any) {
    console.error("[hex-duel/spectate] Error:", error);
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}
