import { auth } from "@clerk/nextjs/server";
import { and, eq, gt, ne, or, asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";

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

    // Verify caller is a player in this game.
    // Use Drizzle's typed operators (`or`, `eq`) instead of raw `sql` tagged
    // templates so the parameter binder doesn't fail with the
    // `drizzle-orm/neon-serverless` driver. The raw template variant crashed
    // every poll of this endpoint with a 500 in production (see Sentry),
    // returning the same error before any Postgres roundtrip.
    const [game] = await db
      .select()
      .from(hexDuelGames)
      .where(
        and(
          eq(hexDuelGames.id, gameId),
          or(
            eq(hexDuelGames.player1Id, userId),
            eq(hexDuelGames.player2Id, userId),
          ),
        ),
      )
      .limit(1);

    if (!game) {
      return NextResponse.json({ success: false, error: "Game not found" }, { status: 404 });
    }

    // Build conditions dynamically (avoid undefined in and() for drizzle compat).
    // Same `ne()` swap as above: raw `sql` template `!= ${userId}` made the
    // drizzle parameter binder throw a JS-level error before reaching Neon.
    const conditions = [
      eq(hexDuelActions.gameId, gameId),
      ne(hexDuelActions.userId, userId),
    ];
    if (afterId > 0) {
      conditions.push(gt(hexDuelActions.id, afterId));
    }

    const actions = await db
      .select()
      .from(hexDuelActions)
      .where(and(...conditions))
      .orderBy(asc(hexDuelActions.id))
      .limit(50);

    const maxId = actions.length > 0 ? Math.max(...actions.map((a) => a.id)) : afterId;

    return NextResponse.json({
      success: true,
      actions: actions.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        sourceKey: a.sourceKey,
        targetKey: a.targetKey,
        troopCount: a.troopCount,
        createdAt: a.createdAt,
      })),
      latestActionId: maxId,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}
