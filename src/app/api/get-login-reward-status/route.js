// app/api/get-login-reward-status/route.js

import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq } from "drizzle-orm";
import { userLoginRewards, users } from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

const STREAK_RESET_DAYS = 2;
const MAX_DAY = 14;

function toUtcDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function GET() {
  try {

    const { userId } = await auth();

    if (!userId)
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 }
      );

    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });

    if (!dbUser)
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );

    let rewardData = await db.query.userLoginRewards.findFirst({
      where: eq(userLoginRewards.userId, dbUser.id),
    });

    // ⭐ Create row if missing
    if (!rewardData) {
      await db.insert(userLoginRewards).values({
        userId: dbUser.id,
        currentDay: 1,
        lastClaimedDate: null,
      });

      rewardData = {
        currentDay: 1,
        lastClaimedDate: null,
      };
    }

    // ✅ Reset streak if missed
    if (rewardData.lastClaimedDate) {

      const now = new Date();
      const lastClaim = new Date(rewardData.lastClaimedDate);

      const elapsedDays = Math.floor((toUtcDayKey(now) - toUtcDayKey(lastClaim)) / (1000 * 60 * 60 * 24));

      if (elapsedDays > STREAK_RESET_DAYS) {

        await db.update(userLoginRewards)
          .set({ currentDay: 1 })
          .where(eq(userLoginRewards.userId, dbUser.id));

        rewardData.currentDay = 1;
      }
    }

    return NextResponse.json({
      success: true,
      currentDay: rewardData.currentDay,
      lastClaimedDate: rewardData.lastClaimedDate,
      maxDay: MAX_DAY,
    });

  } catch (err) {
    console.error(err);

    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
