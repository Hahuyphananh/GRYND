import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db/client";
import { users } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { computeEquippedStreakTitle } from "../../../lib/streakTitles";
import {
  DEFAULT_ICON_KEY,
  isIconKey,
} from "../../../lib/iconAssets";
import { getIconByKey } from "../../../lib/icons";
import { resolveSelectedBannerKey } from "../../../lib/banners";

export async function POST(req: Request) {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    // If DATABASE_URL is not configured (e.g. local dev without a DB),
    // return a minimal response gracefully instead of crashing with 500.
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({
        success: true,
        data: {
          balance: 0,
          name: null,
          email: null,
          selectedIcon: DEFAULT_ICON_KEY,
          profileAccent: null,
          selectedBanner: null,
          avatarFrame: null,
          streakTitle: null,
          selectedStreakType: null,
          dailyStreakCurrent: 0,
          dailyStreakBest: 0,
        },
      });
    }

    const userData = await db
      .select({
        balance: users.balance,
        name: users.name,
        email: users.email,
        selectedIcon: users.selectedIcon,
        profileAccent: users.profileAccent,
        avatarFrame: users.avatarFrame,
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

    // Official icon only — never a user-supplied URL. Hardens the stored
    // value against NULL/malformed/disabled selections by falling back to the
    // default. (A disabled icon can't be equipped, but guard anyway.)
    let selectedIcon: string = isIconKey(user.selectedIcon)
      ? user.selectedIcon
      : DEFAULT_ICON_KEY;
    if (selectedIcon !== DEFAULT_ICON_KEY) {
      const catalog = await getIconByKey(selectedIcon);
      if (!catalog) selectedIcon = DEFAULT_ICON_KEY;
    }

    const selectedBanner = await resolveSelectedBannerKey(clerkId);

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
          selectedIcon,
          profileAccent: user.profileAccent,
          selectedBanner,
          avatarFrame: user.avatarFrame,
          streakTitle: streakInfo.title,
          selectedStreakType: user.selectedStreakType,
          dailyStreakCurrent: user.dailyStreakCurrent,
          dailyStreakBest: user.dailyStreakBest,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(" Error in /api/get-user-tokens:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch user tokens", data: { balance: 0 } },
      { status: 200 },
    );
  }
}
