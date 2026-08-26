import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
    // Public profiles are only served to signed-in users, and even then
    // only non-sensitive stats are exposed — never email (or other
    // contact/PII columns). This closes the PII leak where anyone could
    // fetch any user's email address without authentication.
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { success: false, error: "Authentication required" },
        { status: 401 },
      );
    }

    const clerkId = req.nextUrl.searchParams.get("clerkId");
    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Missing clerkId parameter" },
        { status: 400 },
      );
    }

    const [user] = await db
      .select({
        id: users.id,
        clerkId: users.clerkId,
        name: users.name,
        profilePicture: users.profilePicture,
        level: users.level,
        xp: users.xp,
        gamesWon: users.gamesWon,
        gamesLost: users.gamesLost,
        totalWagered: users.totalWagered,
        totalWon: users.totalWon,
        biggestWin: users.biggestWin,
        currentStreak: users.currentStreak,
        bestStreak: users.bestStreak,
        pvpWins: users.pvpWins,
        referralCount: users.referralCount,
        createdAt: users.createdAt,
        selectedTitle: users.selectedTitle,
        highestTitle: users.highestTitle,
        selectedSpecialTitle: users.selectedSpecialTitle,
        dailyStreakCurrent: users.dailyStreakCurrent,
        dailyStreakBest: users.dailyStreakBest,
      })
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, user });
  } catch (error: any) {
    console.error("[PUBLIC_PROFILE_ERROR]", error);
    return NextResponse.json(
      { success: false, error: "Failed to load profile" },
      { status: 500 },
    );
  }
}
