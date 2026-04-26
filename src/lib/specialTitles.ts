import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { specialTitles, userSecretStats, userSpecialTitles, users } from "../db/schema";

type ActionType = "chat_message" | "bet_placed" | "game_result" | "login_claim" | "referral_invite";

type UnlockMetadata = {
  message?: string;
  isAllIn?: boolean;
  won?: boolean;
  isJackpot?: boolean;
  balanceAfter?: number;
};

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export async function unlockTitle(userId: number, titleKey: string) {
  const existing = await db
    .select({ id: userSpecialTitles.id })
    .from(userSpecialTitles)
    .where(and(eq(userSpecialTitles.userId, userId), eq(userSpecialTitles.titleKey, titleKey)))
    .limit(1);

  if (existing.length) return false;

  await db.insert(userSpecialTitles).values({ userId, titleKey });
  return true;
}

async function ensureSecretStatsRow(userId: number, balance: number) {
  const row = await db.query.userSecretStats.findFirst({
    where: eq(userSecretStats.userId, userId),
  });

  if (row) return row;

  const dayKey = utcDayKey();
  await db.insert(userSecretStats).values({
    userId,
    dayKey,
    dayStartBalance: String(balance || 0),
    lastKnownBalance: String(balance || 0),
  });

  return db.query.userSecretStats.findFirst({ where: eq(userSecretStats.userId, userId) });
}

export async function checkUnlocks(clerkId: string, actionType: ActionType, metadata: UnlockMetadata = {}) {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, balance: true },
  });

  if (!appUser) return [];

  const unlockedNow: string[] = [];
  let stats = await ensureSecretStatsRow(appUser.id, Number(appUser.balance || 0));
  if (!stats) return [];

  const dayKey = utcDayKey();
  let statsPatch: Record<string, number | string> = { updatedAt: new Date().toISOString() };

  if (stats.dayKey !== dayKey) {
    statsPatch.dayKey = dayKey;
    statsPatch.dayStartBalance = String(Number(stats.lastKnownBalance || appUser.balance || 0));
  }

  if (actionType === "chat_message") {
    const message = String(metadata.message || "").toLowerCase();
    statsPatch.chatMessagesCount = Number(stats.chatMessagesCount || 0) + 1;
    if (message.includes("goonbet")) statsPatch.goonbetMentions = Number(stats.goonbetMentions || 0) + 1;
    if (message.includes("all in")) statsPatch.allInPhraseMentions = Number(stats.allInPhraseMentions || 0) + 1;
  }

  if (actionType === "bet_placed" && metadata.isAllIn) {
    statsPatch.allInCount = Number(stats.allInCount || 0) + 1;
  }

  if (actionType === "game_result") {
    const won = !!metadata.won;
    statsPatch.gamesPlayed = Number(stats.gamesPlayed || 0) + 1;
    if (won) {
      statsPatch.winStreak = Number(stats.winStreak || 0) + 1;
      statsPatch.lossStreak = 0;
      statsPatch.allInLossStreak = 0;
    } else {
      statsPatch.lossStreak = Number(stats.lossStreak || 0) + 1;
      statsPatch.winStreak = 0;
      if (metadata.isAllIn) {
        statsPatch.allInLossStreak = Number(stats.allInLossStreak || 0) + 1;
      } else {
        statsPatch.allInLossStreak = 0;
      }
    }

    if (metadata.isJackpot) {
      statsPatch.jackpotsWon = Number(stats.jackpotsWon || 0) + 1;
    }
  }

  if (actionType === "login_claim") {
    statsPatch.loginDays = Number(stats.loginDays || 0) + 1;
  }

  if (typeof metadata.balanceAfter === "number") {
    statsPatch.lastKnownBalance = String(Math.max(0, metadata.balanceAfter));
  }

  await db.update(userSecretStats).set(statsPatch).where(eq(userSecretStats.userId, appUser.id));
  stats = (await db.query.userSecretStats.findFirst({ where: eq(userSecretStats.userId, appUser.id) })) || stats;

  const maybeUnlock = async (condition: boolean, key: string) => {
    if (!condition) return;
    if (await unlockTitle(appUser.id, key)) unlockedNow.push(key);
  };

  const message = String(metadata.message || "").toLowerCase();
  await maybeUnlock(actionType === "chat_message" && message.includes("huy"), "huy");
  await maybeUnlock(Number(stats.chatMessagesCount || 0) >= 1, "talkative_goon");
  await maybeUnlock(Number(stats.chatMessagesCount || 0) >= 100, "chat_addict");
  await maybeUnlock(Number(stats.chatMessagesCount || 0) >= 500, "keyboard_warrior");
  await maybeUnlock(Number(stats.goonbetMentions || 0) >= 10, "loyal_goon");
  await maybeUnlock(Number(stats.allInPhraseMentions || 0) >= 25, "all_in_prophet");

  await maybeUnlock(Number(stats.winStreak || 0) >= 3, "hot_streak");
  await maybeUnlock(Number(stats.winStreak || 0) >= 5, "untouchable");
  await maybeUnlock(Number(stats.winStreak || 0) >= 10, "streak_god");
  await maybeUnlock(Number(stats.jackpotsWon || 0) >= 1, "lucky_rat");

  const currentBalance = Number(metadata.balanceAfter ?? appUser.balance ?? 0);
  const dayStartBalance = Number(stats.dayStartBalance || 0);
  await maybeUnlock(dayStartBalance > 0 && currentBalance >= dayStartBalance * 2, "money_printer");

  await maybeUnlock(Number(stats.allInCount || 0) >= 10, "risk_taker");
  await maybeUnlock(currentBalance <= 0, "broke_again");
  await maybeUnlock(Number(stats.allInLossStreak || 0) >= 5, "certified_degenerate");

  await maybeUnlock(Number(stats.loginDays || 0) >= 30, "regular");
  await maybeUnlock(Number(stats.loginDays || 0) >= 100, "resident_goon");
  await maybeUnlock(actionType === "referral_invite", "recruiter");

  await maybeUnlock(actionType === "chat_message" && message.includes("rigged") && Number(stats.lossStreak || 0) > 0, "salt_lord");
  await maybeUnlock(Number(stats.gamesPlayed || 0) >= 1000, "no_life");

  const unlockedCountRow = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userSpecialTitles)
    .where(eq(userSpecialTitles.userId, appUser.id));
  const unlockedCount = Number(unlockedCountRow[0]?.count || 0);
  await maybeUnlock(unlockedCount >= 10, "collector");

  const totalTitlesRow = await db.select({ count: sql<number>`count(*)::int` }).from(specialTitles);
  const totalTitles = Number(totalTitlesRow[0]?.count || 0);
  if (totalTitles > 0) {
    const finalCountRow = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userSpecialTitles)
      .where(eq(userSpecialTitles.userId, appUser.id));
    await maybeUnlock(Number(finalCountRow[0]?.count || 0) >= totalTitles, "goon_ascended");
  }

  return unlockedNow;
}

export async function getUnlockedSpecialTitles(clerkId: string) {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, selectedSpecialTitle: true },
  });

  if (!appUser) return { selectedSpecialTitle: null, titles: [] };

  const rows = await db
    .select({
      titleKey: userSpecialTitles.titleKey,
      unlockedAt: userSpecialTitles.unlockedAt,
      name: specialTitles.name,
      description: specialTitles.description,
      rarity: specialTitles.rarity,
    })
    .from(userSpecialTitles)
    .innerJoin(specialTitles, eq(userSpecialTitles.titleKey, specialTitles.key))
    .where(eq(userSpecialTitles.userId, appUser.id));

  return {
    selectedSpecialTitle: appUser.selectedSpecialTitle,
    titles: rows,
  };
}
