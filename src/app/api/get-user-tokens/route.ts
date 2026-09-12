import { auth } from "@clerk/nextjs/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "../../../db/client";
import { glows, tokenSubscriptions, users, cosmetics } from "../../../db/schema";
import { computeEquippedStreakTitle } from "../../../lib/streakTitles";
import {
  DEFAULT_ICON_KEY,
  isIconKey,
} from "../../../lib/iconAssets";
import { getIconByKey } from "../../../lib/icons";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../../../lib/stripe/subscriptions";

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
          nameColor: null,
          profileAccent: null,
          streakTitle: null,
          selectedStreakType: null,
          dailyStreakCurrent: 0,
          dailyStreakBest: 0,
          equippedCosmetics: {},
        },
      });
    }

    const userData = await db
      .select({
        balance: users.balance,
        name: users.name,
        email: users.email,
        selectedIcon: users.selectedIcon,
        chatColor: users.chatColor,
        glowColor: glows.color,
        isPremium: sql`(${tokenSubscriptions.status} IS NOT NULL)`,
        profileAccent: users.profileAccent,
        selectedStreakType: users.selectedStreakType,
        dailyStreakCurrent: users.dailyStreakCurrent,
        dailyStreakBest: users.dailyStreakBest,
        equippedCosmetics: users.equippedCosmetics,
      })
      .from(users)
      .leftJoin(
        glows,
        and(eq(glows.key, users.selectedGlow), eq(glows.enabled, true)),
      )
      .leftJoin(
        tokenSubscriptions,
        and(
          eq(tokenSubscriptions.clerkId, users.clerkId),
          inArray(tokenSubscriptions.status, ACTIVE_SUBSCRIPTION_STATUSES),
        ),
      )
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

    // Compute streak title
    const streakInfo = computeEquippedStreakTitle({
      selectedStreakType: user.selectedStreakType,
      dailyStreakCurrent: user.dailyStreakCurrent,
      dailyStreakBest: user.dailyStreakBest,
    });

    // Equipped cosmetics (category → catalog metadata + visual payload) so the
    // client can render profile frames / badges / effects. Server-written only
    // (src/lib/cosmetics.ts); disabled or missing keys are dropped here.
    const equippedMap: Record<string, string> = user.equippedCosmetics || {};
    const equippedKeys = Object.values(equippedMap).filter(Boolean);
    const equippedCosmetics: Record<
      string,
      { key: string; name: string; visual: Record<string, unknown> }
    > = {};
    if (equippedKeys.length > 0) {
      const cosmeticRows = await db
        .select({
          key: cosmetics.key,
          name: cosmetics.name,
          category: cosmetics.category,
          visual: cosmetics.visual,
        })
        .from(cosmetics)
        .where(
          and(inArray(cosmetics.key, equippedKeys), eq(cosmetics.enabled, true)),
        );
      for (const row of cosmeticRows) {
        equippedCosmetics[row.category] = {
          key: row.key,
          name: row.name,
          visual: row.visual,
        };
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          balance: user.balance,
          name: user.name,
          email: user.email,
          selectedIcon,
          // Equipped name color for the client-only (vs-AI) game seats —
          // same precedence as the chat route: an equipped battlepass glow
          // wins; the Grynd+ custom chat color only surfaces for active
          // members.
          nameColor:
            user.glowColor ||
            (Boolean(user.isPremium) ? user.chatColor || null : null),
          profileAccent: user.profileAccent,
          streakTitle: streakInfo.title,
          selectedStreakType: user.selectedStreakType,
          dailyStreakCurrent: user.dailyStreakCurrent,
          dailyStreakBest: user.dailyStreakBest,
          equippedCosmetics,
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
