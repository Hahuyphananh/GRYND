// app/api/get-login-reward-status/route.js
import { NextResponse } from "next/server";
import { db } from "../../../db";
import { eq } from "drizzle-orm";
import { userLoginRewards, users } from "../../../db/schema";
import { auth } from "@clerk/nextjs/server";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });

    const dbUser = await db.query.users.findFirst({ where: eq(users.clerkId, userId) });
    if (!dbUser) return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });

    const rewardData = await db.query.userLoginRewards.findFirst({
      where: eq(userLoginRewards.userId, dbUser.id),
    });

    return NextResponse.json({
      success: true,
      currentDay: rewardData?.currentDay || 1,
      lastClaimedDate: rewardData?.lastClaimedDate || null,
      maxDay: 14
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
