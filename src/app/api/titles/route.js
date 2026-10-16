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
import { cacheOrFetch } from "../../../lib/redis/cache";
import { CacheKeys, CacheTTL } from "../../../lib/redis/keys";

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
    // Per-user cache (CacheKeys.titles), cleared by every write path:
    // /api/titles/select, equip-special, equip-streak and sync.
    //
    // The profile reads this endpoint from three of its loaders at once —
    // loadTitles, loadVipTitles and loadStreakTitles each keep a different
    // slice of the same payload — so without this each profile visit cost
    // three requests and six queries for one unchanged answer. Those three
    // concurrent requests are also collapsed into one client-side by
    // src/lib/dedupeFetch.js.
    //
    // A fetcher returning null is deliberately left uncached: a JSON null reads
    // back as a cache miss, and the missing users row it stands for can appear
    // seconds after a brand-new account's first profile load — caching that 404
    // would hide the player's titles for the whole TTL.
    const titles = await cacheOrFetch(
      CacheKeys.titles(userId),
      CacheTTL.titles,
      async () => {
        const dbUser = await db.query.users.findFirst({
          where: eq(users.clerkId, userId),
          columns: {
            level: true,
            xp: true,
            selectedTitle: true,
            highestTitle: true,
            selectedSpecialTitle: true,
            selectedStreakType: true,
            dailyStreakCurrent: true,
            dailyStreakBest: true,
          },
        });

        if (!dbUser) return null;

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

        return {
          level,
          unlockedTitles,
          selectedTitle: dbUser.selectedTitle || null,
          highestTitle: dbUser.highestTitle || computedHighest?.title || null,
          nextTitle,
          selectedSpecialTitle: selectedSpecialTitle || null,
          allTitles: TITLE_MILESTONES,
          // Streak title info
          selectedStreakType: dbUser.selectedStreakType || null,
          streakTitle: equippedStreak.title,
          streakTitleCurrent: getStreakTitle(Number(dbUser.dailyStreakCurrent || 0)),
          streakTitleBest: getStreakTitle(Number(dbUser.dailyStreakBest || 0)),
          dailyStreakCurrent: Number(dbUser.dailyStreakCurrent || 0),
          dailyStreakBest: Number(dbUser.dailyStreakBest || 0),
          allStreakTitles: getAllStreakTitles(),
        };
      },
    );

    if (!titles) {
      return new Response(
        JSON.stringify({ success: false, error: "User not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({ success: true, ...titles }),
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
