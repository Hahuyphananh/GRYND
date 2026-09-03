import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "../../../../db";
import { users, userStats } from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { DEFAULT_ICON_KEY, isIconKey } from "../../../../lib/iconAssets";
import { getIconByKey } from "../../../../lib/icons";
import { resolveSelectedBannerKey } from "../../../../lib/banners";
import { getLevelFromXp } from "../../../../lib/battlepass";
import {
  getPrestigeStatus,
  resolvePrestigeBadge,
} from "../../../../lib/prestige";

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
        clerkId: users.clerkId,
        name: users.name,
        selectedIcon: users.selectedIcon,
        // Grynd+ cosmetics — public by design (that's the point of showing
        // them off). Cosmetic display data only.
        profileAccent: users.profileAccent,
        selectedBanner: users.selectedBanner,
        avatarFrame: users.avatarFrame,
        level: users.level,
        xp: users.xp,
        prestigeLevel: users.prestigeLevel,
        prestigeNetWins: users.prestigeNetWins,
        showPrestigeBadge: users.showPrestigeBadge,
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
        // Leaderboard-style record — same columns the /classement boards
        // read, so the public profile's stat tabs match the leaderboard.
        record: {
          wins: sql<number>`COALESCE(${userStats.wins}, 0)::int`,
          losses: sql<number>`COALESCE(${userStats.losses}, 0)::int`,
          games: sql<number>`COALESCE(${userStats.totalBets}, 0)::int`,
          winRate: sql<number>`COALESCE(${userStats.winRate}, 0)::numeric`,
          bestStreak: sql<number>`COALESCE(${userStats.bestStreak}, 0)::int`,
          currentStreak: sql<number>`COALESCE(${userStats.currentStreak}, 0)::int`,
          biggestWin: sql<number>`COALESCE(${userStats.biggestWin}, 0)::numeric`,
          favoriteGame: sql<string>`COALESCE(${userStats.favoriteGame}, 'N/A')`,
          pvpWins: sql<number>`COALESCE(${users.pvpWins}, 0)::int`,
          weeklyWins: sql<number>`COALESCE(${userStats.weeklyWins}, 0)::int`,
          weeklyLosses: sql<number>`COALESCE(${userStats.weeklyLosses}, 0)::int`,
          weeklyWinRate: sql<number>`COALESCE(${userStats.weeklyWinRate}, 0)::numeric`,
          weeklyBestStreak: sql<number>`COALESCE(${userStats.weeklyBestStreak}, 0)::int`,
          weeklyCurrentStreak: sql<number>`COALESCE(${userStats.weeklyGameStreak}, 0)::int`,
          weeklyBiggestWin: sql<number>`COALESCE(${userStats.weeklyBiggestWin}, 0)::numeric`,
          dailyStreakCurrent: sql<number>`COALESCE(${userStats.dailyStreakCurrent}, 0)::int`,
          dailyStreakBest: sql<number>`COALESCE(${userStats.dailyStreakBest}, 0)::int`,
          weeklyStreakCurrent: sql<number>`COALESCE(${userStats.weeklyStreakCurrent}, 0)::int`,
          weeklyStreakBest: sql<number>`COALESCE(${userStats.weeklyStreakBest}, 0)::int`,
        },
      })
      .from(users)
      .leftJoin(userStats, eq(userStats.userId, users.id))
      .where(eq(users.clerkId, clerkId))
      .limit(1);

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    // Official Grynd icon only — never expose a stored/legacy avatar URL.
    // Fall back to the default for NULL / malformed / disabled selections.
    let safeIcon: string = isIconKey(user.selectedIcon)
      ? user.selectedIcon
      : DEFAULT_ICON_KEY;
    if (safeIcon !== DEFAULT_ICON_KEY) {
      const catalog = await getIconByKey(safeIcon);
      if (!catalog) safeIcon = DEFAULT_ICON_KEY;
    }

    const selectedBanner = await resolveSelectedBannerKey(clerkId);

    // Battlepass level is derived from XP (wagering + quests), not the
    // possibly-stale stored level column.
    const battlepassLevel = getLevelFromXp(Number(user.xp) || 0);
    // Permanent Prestige — read-only exposure of the server-maintained
    // prestige columns. Prestige state can never be set through this or any
    // other client-facing API.
    const prestige = getPrestigeStatus({
      prestigeLevel: user.prestigeLevel,
      prestigeNetWins: user.prestigeNetWins,
      xp: Number(user.xp) || 0,
    });
    // Server-resolved "Prestige N" badge — only present when the player
    // equipped it AND genuinely earned it (Level 100 + prestige >= 1).
    const prestigeBadge = resolvePrestigeBadge({
      xp: Number(user.xp) || 0,
      prestigeLevel: user.prestigeLevel,
      showPrestigeBadge: user.showPrestigeBadge,
    });
    const { prestigeLevel, prestigeNetWins, ...safeUser } = user;
    return NextResponse.json({
      success: true,
      user: {
        ...safeUser,
        level: battlepassLevel,
        selectedIcon: safeIcon,
        selectedBanner,
        prestige: prestige.prestige,
        prestigeNetWins: prestige.prestigeNetWins,
        nextPrestigeRequirement: prestige.nextPrestigeRequirement,
        prestigeProgressPercent: prestige.prestigeProgressPercent,
        prestigeUnlocked: prestige.prestigeUnlocked,
        prestigeBadge,
      },
    });
  } catch (error: any) {
    console.error("[PUBLIC_PROFILE_ERROR]", error);
    return NextResponse.json(
      { success: false, error: "Failed to load profile" },
      { status: 500 },
    );
  }
}
