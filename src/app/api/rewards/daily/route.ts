// app/api/rewards/daily/route.ts
//
// GET  /api/rewards/daily  → today's login-reward state for the signed-in
//                            player: whether it is claimable, whether the
//                            play gate is satisfied, the streak/cycle day,
//                            what today pays, and the full 7-day curve.
// POST /api/rewards/daily  → claims it. Refuses with a specific, actionable
//                            reason when the player has not played a game
//                            today (403) or already claimed (409).
//
// The reward itself — the curated amounts, the play gate and the
// idempotency guarantees — lives in src/lib/tokens/dailyReward.ts; this route
// is only the HTTP edge over it, so both the status read and the claim can
// never disagree about the rules.
//
// Auth is required for both verbs: there is nothing to show and nothing to
// claim without a player.

import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  claimDailyReward,
  getDailyRewardStatus,
} from "../../../../lib/tokens/dailyReward";
import { logError } from "../../../../lib/logError";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const status = await getDailyRewardStatus(userId);
    if (!status) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, ...status });
  } catch (error) {
    console.error("[DAILY_REWARD_STATUS_ERROR]", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST() {
  let userId: string | null = null;
  try {
    ({ userId } = await auth());
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const result = await claimDailyReward(userId);
    // Narrowed with `in` rather than a truthiness check on `result.ok`: this
    // project compiles with `strict: false`, where discriminated-union
    // narrowing on a boolean literal is not applied.
    if ("error" in result) {
      // 409 (already claimed) and 403 (play gate) are the two expected
      // refusals; both are the UI's instructions, not server faults.
      return NextResponse.json(
        {
          success: false,
          error: result.error,
          ...(result.status === 403 ? { playGateSatisfied: false } : {}),
        },
        { status: result.status },
      );
    }

    return NextResponse.json({
      success: true,
      reward: result.status.reward,
      // What actually landed. `reward` is the advertised amount and the two
      // are equal — the claim refuses rather than under-pay — but the client
      // reads the credited figure so a future cap/rounding change cannot make
      // the confirmation message lie again.
      credited: result.credit,
      balance: result.balance,
      claimedDay: result.status.streakDay,
      cycleDay: result.status.cycleDay,
      today: result.status.today,
      ...result.status,
    });
  } catch (error) {
    console.error("[DAILY_REWARD_CLAIM_ERROR]", error);
    await logError({
      errorType: "daily_reward_error",
      errorMessage:
        error instanceof Error ? error.message : "Daily reward claim failed",
      stackTrace: error instanceof Error ? error.stack : undefined,
      endpoint: "/api/rewards/daily",
      game: "Daily Reward",
      metadata: { operation: "claim_daily_reward", userId: userId ?? null },
    });

    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
