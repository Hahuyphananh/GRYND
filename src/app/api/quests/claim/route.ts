// app/api/quests/claim/route.ts
//
// POST /api/quests/claim  { questId: number }
//
// Claims one COMPLETED quest for the signed-in player.
//
// The request body carries exactly one value — the quest row's id. Everything
// that decides whether it pays (the user, the period, the progress, the target,
// the reward, the claimed flag) is read from the database inside the claim
// transaction. A client can never set its own progress, target, reward,
// completion or claimed state, and there is no field here that would let it try.
//
// Refusals are the UI's instructions, not server faults:
//   401  no session
//   400  not a valid quest id
//   404  no such quest for this player
//   409  incomplete / already claimed / expired period
//
// The payout, its idempotency and the balance it returns live in
// src/lib/quests/claim.ts.

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { claimQuestReward } from "../../../../lib/quests/claim";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated", reason: "unauthenticated" },
        { status: 401 },
      );
    }

    // Only the quest id is read from the body. No user id, no amount, no
    // progress — anything else a caller sends is ignored entirely.
    const body = await req.json().catch(() => ({}));
    const questId = (body as { questId?: unknown })?.questId;

    const result = await claimQuestReward({ clerkId: userId, questId });
    // Narrowed with `in` rather than a truthiness check on `result.ok`: this
    // project compiles with `strict: false`, where discriminated-union narrowing
    // on a boolean literal is not applied (same shape as the daily reward route).
    if ("error" in result) {
      return NextResponse.json(
        { success: false, error: result.error, reason: result.reason },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      // What the ledger actually paid (the row's stored reward).
      credited: result.credited,
      // The canonical balance after the credit — never derived on the client.
      balance: result.balance,
      quest: result.quest,
      daily: result.board.daily,
      weekly: result.board.weekly,
      periodKeys: result.board.periodKeys,
      resets: result.board.resets,
    });
  } catch (error) {
    console.error("[QUEST_CLAIM_ERROR]", error);
    await logError({
      errorType: "quest_error",
      errorMessage:
        error instanceof Error ? error.message : "Quest claim failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/quests/claim",
      game: "Quests",
      metadata: { operation: "claim_quest_reward", userId: userId ?? null },
    });
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
