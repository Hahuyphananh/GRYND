// app/api/claim-login-reward/route.js

import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq, sql } from "drizzle-orm";
import { userLoginRewards, users } from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";
import { claimIdempotency } from "../../../lib/security/idempotency";
import { getMembershipTier } from "../../../lib/stripe/subscriptions";
import { checkUnlocks } from "../../../lib/specialTitles";
import { updateDailyStreak } from "../../../lib/dailyStreak";
import { hasItem } from "../../../lib/shopItems";
import { getAllStreakTitles, getStreakTitle, getNextStreakMilestone } from "../../../lib/streakTitles";
import { logError } from "../../../lib/logError";

// Tokens per streak day — linear escalation (50 × day). The old exponential
// curve (100 × 2^(day-1)) topped out at 819,200 tokens on day 14 (~$820 at
// the 1,000 tokens/$ economy rate) and paid ~1.64M tokens per perfect cycle —
// it made every other token source pointless. The economy is now anchored at
// ~1,000 tokens/$ (packs + Grynd+ grant): 50 × day keeps the escalating
// daily hook while a perfect 14-day cycle is worth ~5,250 tokens (~$5).
// Economy rebalance: free logins are worth ~$5/mo (≈ the Grynd+ 5,000-token
// monthly grant) instead of ~$10.50/mo — the subscription stays the premium
// path. (Was 50/day; audit finding #4 — trim faucets.)
const LOGIN_REWARD_PER_DAY = 25;
const MAX_DAY = 14;
const STREAK_RESET_DAYS = 1;

// Streak milestone bonus rewards (awarded when daily streak hits these
// thresholds) — scaled down to match the new economy (~1,000 tokens/$).
const STREAK_MILESTONE_BONUSES = {
  3: 12,
  5: 25,
  7: 50,
  10: 75,
  14: 125,
  21: 200,
  30: 300,
  45: 450,
  60: 600,
  75: 800,
  100: 1250,
  150: 2000,
  200: 3000,
  365: 5000,
};

function toUtcDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function POST(req) {
  // Hoisted so the catch handler below can log the clerk id on any failure.
  let userId = null;
  try {
    ({ userId } = await auth());

    const idem = await claimIdempotency(req, "rewards:claim-login", 180);
    if (idem.enforced && !idem.allowed) {
      return NextResponse.json(
        { success: false, error: "Duplicate request" },
        { status: 409 },
      );
    }

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!dbUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    const uid = dbUser.id;

    let rewardData = await db.query.userLoginRewards.findFirst({
      where: eq(userLoginRewards.userId, uid),
    });

    //  First login
    if (!rewardData) {
      await db.insert(userLoginRewards).values({
        userId: uid,
        currentDay: 1,
        lastClaimedDate: null,
      });

      rewardData = {
        currentDay: 1,
        lastClaimedDate: null,
      };
    }

    const now = new Date();
    const nowDayKey = toUtcDayKey(now);

    if (rewardData.lastClaimedDate) {
      const lastClaim = new Date(rewardData.lastClaimedDate);
      const lastDayKey = toUtcDayKey(lastClaim);
      const elapsedDays = Math.floor(
        (nowDayKey - lastDayKey) / (1000 * 60 * 60 * 24),
      );

      //  RESET streak if missed too long — unless a Daily Streak Shield
      //  absorbs the missed day. Ownership is checked NON-consuming here;
      //  the shield is actually spent once inside updateDailyStreak (the
      //  single consumption point) when it preserves dailyStreakCurrent.
      if (elapsedDays > STREAK_RESET_DAYS) {
        const shielded = await hasItem(uid, "streak_shield", 1);
        if (!shielded) {
          await db
            .update(userLoginRewards)
            .set({
              currentDay: 1,
            })
            .where(eq(userLoginRewards.userId, uid));

          rewardData.currentDay = 1;
        }
      }

      //  Cooldown check
      if (elapsedDays === 0) {
        return NextResponse.json(
          {
            success: false,
            error: "Reward already claimed today. Try again tomorrow.",
          },
          { status: 400 },
        );
      }
    }

    //  Calculate reward AFTER reset logic. Members earn a bonus on the daily
    //  login reward scaled by tier: Grynd+ +50%, Grynd Pro +75%, Grynd High
    //  Roller +100% (perk: login bonus multiplier).
    const tier = await getMembershipTier(userId);
    const baseReward = LOGIN_REWARD_PER_DAY * rewardData.currentDay;
    const tierMultiplier =
      tier === "high_roller" ? 2 : tier === "pro" ? 1.75 : tier === "grynd_plus" ? 1.5 : 1;
    const reward = Math.round(baseReward * tierMultiplier);
    const premiumBonus = reward - baseReward;

    await db
      .update(users)
      .set({
        balance: sql`${users.balance} + ${reward}`,
      })
      .where(eq(users.id, uid));

    const nextDay =
      rewardData.currentDay >= MAX_DAY ? 1 : rewardData.currentDay + 1;

    await db
      .update(userLoginRewards)
      .set({
        currentDay: nextDay,
        lastClaimedDate: now.toISOString(),
      })
      .where(eq(userLoginRewards.userId, uid));

    const updatedBalance = Number(dbUser.balance || 0) + reward;
    const unlockedSpecialTitles = await checkUnlocks(userId, "login_claim", {
      balanceAfter: updatedBalance,
    });

    // Update daily & weekly streaks on the users + userStats tables
    // so the leaderboard and profile page show up-to-date values
    let streakResult = null;
    try {
      streakResult = await updateDailyStreak(userId);
    } catch (streakErr) {
      console.error("[CLAIM_LOGIN_REWARD] streak update failed (non-fatal):", streakErr);
      await logError({
        errorType: "login_reward_streak_error",
        errorMessage: streakErr instanceof Error ? streakErr.message : "Daily streak update failed",
        stackTrace: streakErr instanceof Error ? streakErr.stack : undefined,
        endpoint: "/api/claim-login-reward",
        game: "Login Reward",
        metadata: { operation: "update_daily_streak", userId },
      });
    }

    // ── Streak milestone bonus ──
    // Check if the user just crossed a milestone threshold
    const newStreak = streakResult?.dailyStreakCurrent ?? 0;
    const oldStreak = dbUser.dailyStreakCurrent ?? 0;
    let milestoneBonus = 0;
    let milestoneTitle = null;

    const allStreakTitles = getAllStreakTitles();
    for (const entry of allStreakTitles) {
      if (newStreak === entry.days && oldStreak < entry.days) {
        milestoneBonus = STREAK_MILESTONE_BONUSES[entry.days] || 0;
        milestoneTitle = entry.title;
        break;
      }
    }

    // Find next milestone for progress display
    const nextMilestone = getNextStreakMilestone(newStreak);

    // Award milestone bonus if any
    if (milestoneBonus > 0) {
      try {
        await db
          .update(users)
          .set({
            balance: sql`${users.balance} + ${milestoneBonus}`,
          })
          .where(eq(users.id, uid));
      } catch (bonusErr) {
        console.error("[CLAIM_LOGIN_REWARD] milestone bonus award failed:", bonusErr);
        await logError({
          errorType: "login_reward_milestone_error",
          errorMessage: bonusErr instanceof Error ? bonusErr.message : "Milestone bonus award failed",
          stackTrace: bonusErr instanceof Error ? bonusErr.stack : undefined,
          endpoint: "/api/claim-login-reward",
          game: "Login Reward",
          metadata: { operation: "award_milestone_bonus", userId, milestoneBonus },
        });
        milestoneBonus = 0;
      }
    }

    return NextResponse.json({
      success: true,
      reward,
      premium: tier !== null,
      premiumBonus,
      claimedDay: rewardData.currentDay,
      nextDay,
      unlockedSpecialTitles,
      dailyStreakCurrent: streakResult?.dailyStreakCurrent ?? 0,
      dailyStreakBest: streakResult?.dailyStreakBest ?? 0,
      weeklyStreakCurrent: streakResult?.weeklyStreakCurrent ?? 0,
      weeklyStreakBest: streakResult?.weeklyStreakBest ?? 0,
      milestoneBonus,
      milestoneTitle,
      nextMilestone,
      streakTitle: getStreakTitle(newStreak),
    });
  } catch (err) {
    console.error("[CLAIM_LOGIN_REWARD_ERROR]", err);
    await logError({
      errorType: "login_reward_error",
      errorMessage: err instanceof Error ? err.message : "Login reward request failed",
      stackTrace: err instanceof Error ? err.stack : undefined,
      endpoint: "/api/claim-login-reward",
      game: "Login Reward",
      metadata: { operation: "claim_reward", userId: userId ?? null },
    });

    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
