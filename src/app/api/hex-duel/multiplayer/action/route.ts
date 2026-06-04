import { auth } from "@clerk/nextjs/server";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { gameId, actionType, sourceKey, targetKey, troopCount } = await req.json() as {
      gameId: number;
      actionType: string;
      sourceKey?: string;
      targetKey?: string;
      troopCount?: number;
    };

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    if (!actionType || !["attack", "displace", "endTurn", "skipRound"].includes(actionType)) {
      return NextResponse.json({ success: false, error: "Invalid actionType" }, { status: 400 });
    }

    // Verify caller is a player in this game
    const [game] = await db
      .select()
      .from(hexDuelGames)
      .where(
        and(
          eq(hexDuelGames.id, gameId),
          sql`(${hexDuelGames.player1Id} = ${userId} OR ${hexDuelGames.player2Id} = ${userId})`,
        ),
      )
      .limit(1);

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    const [action] = await db
      .insert(hexDuelActions)
      .values({
        gameId,
        userId,
        actionType,
        sourceKey: sourceKey ?? null,
        targetKey: targetKey ?? null,
        troopCount: troopCount ?? null,
      })
      .returning({ id: hexDuelActions.id, createdAt: hexDuelActions.createdAt });

    return NextResponse.json({
      success: true,
      action: { id: action.id, createdAt: action.createdAt },
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}
