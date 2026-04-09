// app/api/claim-login-reward/route.js

import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq, sql } from "drizzle-orm";
import { userLoginRewards, users } from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";
import { claimIdempotency } from "../../../lib/security/idempotency";

const LOGIN_REWARD_BASE = 100;
const MAX_DAY = 14;
const COOLDOWN_DAYS = 1;
const STREAK_RESET_DAYS = 2;

function toUtcDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function POST(req) {
  try {

    const { userId } = await auth();

    const idem = await claimIdempotency(req, "rewards:claim-login", 180);
    if (idem.enforced && !idem.allowed) {
      return NextResponse.json({ success: false, error: "Duplicate request" }, { status: 409 });
    }

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );
    }

    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!dbUser) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    const uid = dbUser.id;

    let rewardData = await db.query.userLoginRewards.findFirst({
      where: eq(userLoginRewards.userId, uid),
    });

    // ⭐ First login
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
      const elapsedDays = Math.floor((nowDayKey - toUtcDayKey(lastClaim)) / (1000 * 60 * 60 * 24));

      // ✅ RESET streak if missed too long
      if (elapsedDays > STREAK_RESET_DAYS) {

        await db.update(userLoginRewards)
          .set({
            currentDay: 1,
          })
          .where(eq(userLoginRewards.userId, uid));

        rewardData.currentDay = 1;
      }

      // ✅ Cooldown check
      if (elapsedDays < COOLDOWN_DAYS) {

        return NextResponse.json(
          {
            success: false,
            error: "Reward already claimed today. Try again tomorrow.",
          },
          { status: 400 }
        );
      }
    }

    // ⭐ Calculate reward AFTER reset logic
    const reward = LOGIN_REWARD_BASE * 2 ** (rewardData.currentDay - 1);

    await db.update(users)
      .set({
        balance: sql`${users.balance} + ${reward}`,
      })
      .where(eq(users.id, uid));

    const nextDay =
      rewardData.currentDay >= MAX_DAY
        ? 1
        : rewardData.currentDay + 1;

    await db.update(userLoginRewards)
      .set({
        currentDay: nextDay,
        lastClaimedDate: now.toISOString().slice(0, 10),
      })
      .where(eq(userLoginRewards.userId, uid));

    return NextResponse.json({
      success: true,
      reward,
      claimedDay: rewardData.currentDay,
      nextDay,
    });

  } catch (err) {
    console.error("[CLAIM_LOGIN_REWARD_ERROR]", err);

    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
