import { NextRequest, NextResponse } from "next/server";
import { db } from "../../../../db";
import { users } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export async function GET(req: NextRequest) {
  try {
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
        email: users.email,
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
