// app/api/quests/route.ts
//
// GET /api/quests → the signed-in player's daily + weekly quest board:
//                   each quest's objective, progress, target, reward and state,
//                   the period each board belongs to, and the balance the
//                   rewards are paid into.
//
// The rules live in src/lib/quests/claim.ts (read) and src/lib/quests/settle.ts
// (progress); this route is only the HTTP edge, so the board a player sees and
// the claim they can make can never disagree about what is complete.
//
// Auth is required: there is no board without a player, and progress is never
// read for a client-supplied id.

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getQuestStatus } from "../../../lib/quests/claim";
import { logError } from "../../../lib/logError";

// A quest board is per-player and changes with every settled match, so it is
// never prerendered or cached at the route level.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const result = await getQuestStatus({ clerkId: userId });
    // `in` narrowing: `strict: false` does not narrow on a boolean literal.
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      daily: result.daily,
      weekly: result.weekly,
      balance: result.balance,
      periodKeys: result.periodKeys,
      resets: result.resets,
    });
  } catch (error) {
    console.error("[QUEST_BOARD_ERROR]", error);
    await logError({
      errorType: "quest_error",
      errorMessage:
        error instanceof Error ? error.message : "Quest board read failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/quests",
      game: "Quests",
      metadata: { operation: "read_quest_board" },
    });
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
