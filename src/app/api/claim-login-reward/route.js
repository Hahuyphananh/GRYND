// app/api/claim-login-reward/route.js
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq, sql } from "drizzle-orm";
import { userLoginRewards, users } from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

const LOGIN_REWARD_BASE = 100;
const MAX_DAY = 14;

export async function GET() {
  try {
    // 1️⃣ Authenticate user
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });
    }

    // 2️⃣ Get internal user ID
    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
    });
    if (!dbUser) {
      return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
    }
    const uid = dbUser.id;

    // 3️⃣ Fetch login reward record
    let rewardData = await db.query.userLoginRewards.findFirst({
      where: eq(userLoginRewards.userId, uid),
    });

    // 4️⃣ First-time user: insert record
    if (!rewardData) {
      await db.insert(userLoginRewards).values({
        userId: uid,
        currentDay: 1,
        lastClaimedDate: null,
      });
      rewardData = {
        userId: uid,
        currentDay: 1,
        lastClaimedDate: null,
      };
    }

    // 5️⃣ Check if already claimed today
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    let lastClaimedDateStr = null;
    if (rewardData.lastClaimedDate) {
      lastClaimedDateStr = rewardData.lastClaimedDate instanceof Date
        ? rewardData.lastClaimedDate.toISOString().slice(0, 10)
        : rewardData.lastClaimedDate.slice(0, 10);
    }

    if (lastClaimedDateStr === today) {
      return NextResponse.json({ success: false, error: "Reward already claimed today" }, { status: 400 });
    }

    // 6️⃣ Calculate today's reward
    const reward = LOGIN_REWARD_BASE * 2 ** (rewardData.currentDay - 1);

    // 7️⃣ Update user's balance in users table
    await db.update(users)
      .set({ balance: sql`${users.balance} + ${reward}` })
      .where(eq(users.id, uid));

    // 8️⃣ Update login reward record
    await db.update(userLoginRewards)
      .set({
        currentDay: Math.min(rewardData.currentDay + 1, MAX_DAY),
        lastClaimedDate: today, // store as string "YYYY-MM-DD"
      })
      .where(eq(userLoginRewards.userId, uid));

    // 9️⃣ Return response
    return NextResponse.json({
      success: true,
      reward,
      nextDay: Math.min(rewardData.currentDay + 1, MAX_DAY),
    });
  } catch (err) {
    console.error("[CLAIM_LOGIN_REWARD_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
