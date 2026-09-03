import { auth } from "@clerk/nextjs/server";
import { db } from "../../../db";
import { eq } from "drizzle-orm";
import { specialTitles, users } from "../../../db/schema";
import {
  TITLE_MILESTONES,
  getUnlockedTitles,
  getHighestTitle,
  getNextTitle,
} from "../../../lib/titles";
import {
  computeEquippedStreakTitle,
  getStreakTitle,
  getAllStreakTitles,
} from "../../../lib/streakTitles";
import {
  getPrestigeStatus,
  resolvePrestigeBadge,
} from "../../../lib/prestige";

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const dbUser = await db.query.users.findFirst({
      where: eq(users.clerkId, userId),
      columns: {
        level: true,
        xp: true,
        prestigeLevel: true,
        showPrestigeBadge: true,
        selectedTitle: true,
        highestTitle: true,
        selectedSpecialTitle: true,
        selectedStreakType: true,
        dailyStreakCurrent: true,
        dailyStreakBest: true,
      },
    });

    if (!dbUser) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const level = Number(dbUser.level || 1);
    const unlockedTitles = getUnlockedTitles(level);
    const computedHighest = getHighestTitle(level);
    const nextTitle = getNextTitle(level);
    let selectedSpecialTitle = null;

    if (dbUser.selectedSpecialTitle) {
      const specialTitleRow = await db.query.specialTitles.findFirst({
        where: eq(specialTitles.key, dbUser.selectedSpecialTitle),
        columns: { name: true },
      });
      selectedSpecialTitle = specialTitleRow?.name || null;
    }

    // Compute equipped streak title
    const equippedStreak = computeEquippedStreakTitle(dbUser);
    const streakTitle = equippedStreak.title;

    // Server-resolved Prestige state — used by the navbar for the badge
    // chip and the global "Prestige unlocked" notice. The badge text is
    // always derived here from the real columns, never from the client.
    const prestigeStatus = getPrestigeStatus({
      prestigeLevel: Number(dbUser.prestigeLevel) || 0,
      prestigeNetWins: 0,
      xp: Number(dbUser.xp) || 0,
    });
    const prestigeBadge = resolvePrestigeBadge({
      xp: Number(dbUser.xp) || 0,
      prestigeLevel: Number(dbUser.prestigeLevel) || 0,
      showPrestigeBadge: Boolean(dbUser.showPrestigeBadge),
    });

    return new Response(
      JSON.stringify({
        success: true,
        level,
        prestige: prestigeStatus.prestige,
        prestigeUnlocked: prestigeStatus.prestigeUnlocked,
        prestigeBadge,
        unlockedTitles,
        selectedTitle: dbUser.selectedTitle || null,
        highestTitle: dbUser.highestTitle || computedHighest?.title || null,
        nextTitle,
        selectedSpecialTitle: selectedSpecialTitle || null,
        allTitles: TITLE_MILESTONES,
        // Streak title info
        selectedStreakType: dbUser.selectedStreakType || null,
        streakTitle,
        streakTitleCurrent: getStreakTitle(Number(dbUser.dailyStreakCurrent || 0)),
        streakTitleBest: getStreakTitle(Number(dbUser.dailyStreakBest || 0)),
        dailyStreakCurrent: Number(dbUser.dailyStreakCurrent || 0),
        dailyStreakBest: Number(dbUser.dailyStreakBest || 0),
        allStreakTitles: getAllStreakTitles(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[GET_TITLES_ERROR]", error);
    return new Response(
      JSON.stringify({ success: false, error: "Failed to load titles" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
