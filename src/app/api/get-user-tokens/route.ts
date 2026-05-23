import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { computeEquippedStreakTitle } from "../../../lib/streakTitles";

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const userData = await db
      .select({
        balance: users.balance,
        name: users.name,
        email: users.email,
        profilePicture: users.profilePicture,
        selectedStreakType: users.selectedStreakType,
        dailyStreakCurrent: users.dailyStreakCurrent,
        dailyStreakBest: users.dailyStreakBest,
      })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (userData.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "User not found",
          shouldInitialize: true,
        },
        { status: 404 },
      );
    }

    const user = userData[0];

    // Compute streak title
    const streakInfo = computeEquippedStreakTitle({
      selectedStreakType: user.selectedStreakType,
      dailyStreakCurrent: user.dailyStreakCurrent,
      dailyStreakBest: user.dailyStreakBest,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          balance: user.balance,
          name: user.name,
          email: user.email,
          profilePicture: user.profilePicture,
          streakTitle: streakInfo.title,
          selectedStreakType: user.selectedStreakType,
          dailyStreakCurrent: user.dailyStreakCurrent,
          dailyStreakBest: user.dailyStreakBest,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("❌ Error in /api/get-user-tokens:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Server error",
        details: error instanceof Error ? error.message : "Unknown",
      },
      { status: 500 },
    );
  }
}
