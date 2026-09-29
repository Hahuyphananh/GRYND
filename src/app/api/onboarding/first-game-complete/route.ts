// app/api/onboarding/first-game-complete/route.ts
//
// POST /api/onboarding/first-game-complete
//
// Called once, from the Free Play vs AI tutorial match, only when the match
// reaches its real terminal state (the result screen is shown). It
// atomically claims the one-time completion: UPDATE ... WHERE
// first_game_completed_at IS NULL. Whichever request wins (double-taps,
// refreshes, several tabs) sets the timestamp; every loser sees the
// already-completed branch and grants nothing.
//
// The Battle Pass (and its one-time FIRST_GAME_BONUS_XP) has been removed, so
// this endpoint now only records the completion flags and reports the stored
// legacy level/xp unchanged.
//
// Idempotent: the flags are set at most once per account, ever.

import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // ── Atomic one-time claim ────────────────────────────────────────
    // Only a request that finds the flag NULL wins the claim; concurrent
    // duplicate submissions (two tabs, refresh races) get zero rows back.
    const claimed = await db
      .update(users)
      .set({
        firstGameCompletedAt: new Date(),
        // The walkthrough flag may still be NULL if the earlier completion
        // POST never landed (flaky network) — finishing the tutorial match is
        // the strongest signal of all, so backfill it too.
        onboardingCompletedAt: new Date(),
      })
      .where(
        and(eq(users.clerkId, userId), isNull(users.firstGameCompletedAt)),
      )
      .returning({ id: users.id });

    // Report the player's stored (legacy) standing. No progression is granted.
    const rows = await db
      .select({ level: users.level, xp: users.xp })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    const level = Number(rows[0]?.level ?? 1);
    const xp = Number(rows[0]?.xp ?? 0);

    return Response.json({
      success: true,
      alreadyCompleted: claimed.length === 0,
      xpGranted: 0,
      fromLevel: level,
      fromXp: xp,
      toLevel: level,
      toXp: xp,
      leveledUp: false,
    });
  } catch (err) {
    console.error("[FIRST_GAME_COMPLETE_ERROR]", err);
    return Response.json(
      { success: false, error: "Failed to save first-game progress" },
      { status: 500 },
    );
  }
}
