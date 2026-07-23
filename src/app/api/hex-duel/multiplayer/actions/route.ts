import { auth } from "@clerk/nextjs/server";
import { and, eq, gt, not, or, asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../../../db/client";
import { hexDuelActions, hexDuelGames } from "../../../../../db/schema";

export async function GET(req: Request) {
  // Hoisted above the try so the catch block's diagnostics can read them
  // without re-parsing req.url. Defaults are overwritten by the parser
  // below in the happy path; safe fallback values keep catch diagnostics
  // sensible if the throw happened during URL parsing (gameId stays NaN,
  // afterId stays 0).
  let gameId: number = NaN;
  let afterId = 0;

  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    gameId = Number(searchParams.get("gameId"));
    afterId = Number(searchParams.get("afterId")) || 0;

    if (!Number.isFinite(gameId) || gameId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid gameId" }, { status: 400 });
    }

    // Verify caller is a player in this game.
    // Two historical fixes painted this 500 in production:
    //   1. The raw `sql\`(${player1Id} = ${userId} OR ...)\`` template was
    //      replaced with typed `or(eq(...), eq(...))`. The raw template's
    //      neon-serverless parameter binder threw before the Postgres
    //      roundtrip. (See Sentry.)
    //   2. The bare `ne(hexDuelActions.userId, userId)` operator in the
    //      actions filter is also suspected to share the same parameter-
    //      binder fragility, and was replaced with `not(eq(...))` which
    //      takes the standard parameterized path through Drizzle.
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
    // Use `not(eq(...))` instead of the standalone `ne()` operator as a
    // defensive choice under the `drizzle-orm/neon-serverless` driver —
    // bare `ne()` is suspected (unverified) to share the same
    // parameter-binder issue as the raw `sql\`!= ${userId}\`` template
    // it replaced. `not(eq(...))` produces semantically identical SQL
    // (`<> $1`) via Drizzle's standard parameterized path. Even if this
    // is a placebo, the prior fix (swapping raw `sql` templates for
    // typed operators) should already resolve the 500 — this just
    // removes the questionable operator entirely.
    const conditions = [
      eq(hexDuelActions.gameId, gameId),
      not(eq(hexDuelActions.userId, userId)),
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

    // Match the sibling `spectate/route.ts` pattern so the two near-
    // identical files read the same way. `Math.max()` of an empty array
    // is `-Infinity`, so guard against zero results by falling back to
    // `afterId` (the last-known client checkpoint).
    const maxId =
      actions.length > 0
        ? Math.max(...actions.map((a) => a.id))
        : afterId;

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
    // Log the underlying error server-side so Vercel function logs (and
    // Sentry if wired up) actually capture the cause. Without this, every
    // 500 was returning only the generic JSON body and the real stack
    // trace was lost — making the bug invisible in production.
    // `gameId` / `afterId` are hoisted above so they are in scope here
    // even when the failure happened before/during URL parsing.
    console.error(
      "[hex-duel/multiplayer/actions] GET failed",
      {
        url: req.url,
        gameId,
        afterId,
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
