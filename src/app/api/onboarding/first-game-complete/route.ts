// app/api/onboarding/first-game-complete/route.ts
//
// POST /api/onboarding/first-game-complete
//
// Called once, from the Free Play vs AI tutorial match, only when the match
// reaches its real terminal state (the result screen is shown). It:
//
//   1. Atomically claims the one-time completion: UPDATE ... WHERE
//      first_game_completed_at IS NULL. Whichever request wins (double-taps,
//      refreshes, several tabs) sets the timestamp; every loser sees the
//      already-completed branch and grants nothing.
//   2. Grants the one-time FIRST_GAME_BONUS_XP through the existing
//      src/lib/battlepass.js addExp pipeline (users + user_stats, level
//      recomputed by the shared formula). Free-play matches otherwise award
//      zero XP — this is the single explicit onboarding exception, and it is
//      separate from wagered-game rewards in both direction and amount.
//
// Returns the pre/post Battle Pass level + XP so the client can render the
// "first XP" progression moment from real server numbers. Idempotent: the
// bonus is granted at most once per account, ever.

import { auth } from "@clerk/nextjs/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../../db/client";
import { users } from "../../../../db/schema";
import { addExp, FIRST_GAME_BONUS_XP } from "../../../../lib/battlepass";

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) {
      return Response.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // ── Step 1: atomic one-time claim ────────────────────────────────
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
      .returning({ id: users.id, level: users.level, xp: users.xp });

    // ── Step 2a: first completion → grant the one-time XP bonus ───────
    if (claimed[0]) {
      const before = {
        level: Number(claimed[0].level ?? 1),
        xp: Number(claimed[0].xp ?? 0),
      };

      const after = await addExp(claimed[0].id, FIRST_GAME_BONUS_XP);
      const to = {
        level: Number(after?.level ?? before.level),
        xp: Number(after?.xp ?? before.xp + FIRST_GAME_BONUS_XP),
      };

      return Response.json({
        success: true,
        alreadyCompleted: false,
        xpGranted: FIRST_GAME_BONUS_XP,
        fromLevel: before.level,
        fromXp: before.xp,
        toLevel: to.level,
        toXp: to.xp,
        leveledUp: to.level > before.level,
      });
    }

    // ── Step 2b: already completed → no-op, report current standing ───
    const rows = await db
      .select({ level: users.level, xp: users.xp })
      .from(users)
      .where(eq(users.clerkId, userId))
      .limit(1);

    const level = Number(rows[0]?.level ?? 1);
    const xp = Number(rows[0]?.xp ?? 0);

    return Response.json({
      success: true,
      alreadyCompleted: true,
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
