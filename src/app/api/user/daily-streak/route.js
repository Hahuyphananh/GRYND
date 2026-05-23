// app/api/user/daily-streak/route.js
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { updateDailyStreak } from "../../../../lib/dailyStreak";

/**
 * POST /api/user/daily-streak
 *
 * Called when a user visits the app (or logs in) to update their
 * daily login streak. Idempotent — calling multiple times per day
 * is safe (only the first call updates anything).
 */
export async function POST() {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Not authenticated" },
        { status: 401 },
      );
    }

    const result = await updateDailyStreak(userId);

    if (!result) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      dailyStreakCurrent: result.dailyStreakCurrent,
      dailyStreakBest: result.dailyStreakBest,
      updated: result.updated,
    });
  } catch (err) {
    console.error("[DAILY_STREAK_ERROR]", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
