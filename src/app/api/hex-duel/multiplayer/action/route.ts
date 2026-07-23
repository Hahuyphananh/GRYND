import { auth } from "@clerk/nextjs/server";
import { and, eq, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";

export async function POST(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read
  // them without re-parsing the request body. Safe fallback values
  // keep catch diagnostics sensible if the throw happened during
  // JSON parsing.
  let gameId: number = NaN;
  let actionType: string | null = null;

  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      gameId?: unknown;
      actionType?: unknown;
      sourceKey?: string | null;
      targetKey?: string | null;
      troopCount?: number | null;
    };
    gameId = Number(body.gameId);
    actionType = typeof body.actionType === "string" ? body.actionType : null;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    if (
      !actionType ||
      !["attack", "displace", "endTurn", "skipRound"].includes(actionType)
    ) {
      return NextResponse.json({ success: false, error: "Invalid actionType" }, { status: 400 });
    }

    const sourceKey = typeof body.sourceKey === "string" ? body.sourceKey : null;
    const targetKey = typeof body.targetKey === "string" ? body.targetKey : null;
    const troopCount =
      typeof body.troopCount === "number" && Number.isFinite(body.troopCount)
        ? body.troopCount
        : null;

    // Verify caller is a player in this game.
    // Uses typed `or(eq(...), eq(...))` instead of the raw
    // `sql\`(${hexDuelGames.player1Id} = ${userId} OR ...)\`` template,
    // which has parameter-binder fragility under
    // `drizzle-orm/neon-serverless` and was the root cause of prior
    // 500s on the sibling `actions/route.ts` (now fixed).
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

    const [action] = await db
      .insert(hexDuelActions)
      .values({
        gameId,
        userId,
        actionType,
        sourceKey,
        targetKey,
        troopCount,
      })
      .returning({ id: hexDuelActions.id, createdAt: hexDuelActions.createdAt });

    return NextResponse.json({
      success: true,
      action: { id: action.id, createdAt: action.createdAt },
    });
  } catch (error: any) {
    // Log the underlying error server-side so Vercel function logs
    // (and Sentry if wired up) actually capture the cause. Without
    // this, every 500 returned only the generic JSON body and the
    // real stack trace was lost — making the bug invisible in prod.
    // `gameId` / `actionType` are hoisted above so they are in scope
    // here even when the failure happened during JSON parsing.
    console.error(
      "[hex-duel/multiplayer/action] POST failed",
      {
        url: req.url,
        gameId,
        actionType,
        err: error?.message,
        stack: error?.stack,
      },
    );
    return NextResponse.json(
      { success: false, error: error?.message || "Server error" },
      { status: 500 },
    );
  }
}
