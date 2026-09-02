// src/lib/banners.ts
//
// Server authority for official profile banners. Stable banner keys identify
// cosmetics everywhere; asset paths and metadata always come from the catalog.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { banners, userBanners, users } from "../db/schema";
import {
  bannerAssetUrl,
  isBannerKey,
  normalizeBannerKey,
  OFFICIAL_BANNER_DEFINITIONS,
} from "./bannerAssets";

export { isBannerKey, normalizeBannerKey, OFFICIAL_BANNER_DEFINITIONS } from "./bannerAssets";

export type BannerRow = typeof banners.$inferSelect;

export async function getBannerByKey(key: string): Promise<BannerRow | null> {
  const normalized = normalizeBannerKey(key);
  if (!normalized) return null;
  const [row] = await db
    .select()
    .from(banners)
    .where(and(eq(banners.key, normalized), eq(banners.enabled, true)))
    .limit(1);
  return row ?? null;
}

export async function getEnabledBanners(): Promise<BannerRow[]> {
  return db
    .select()
    .from(banners)
    .where(eq(banners.enabled, true))
    .orderBy(asc(banners.sortOrder), asc(banners.id));
}

export async function unlockBanner(userId: number, bannerKey: unknown): Promise<boolean> {
  const key = normalizeBannerKey(bannerKey);
  if (!key) return false;

  const inserted = await db
    .insert(userBanners)
    .values({ userId, bannerKey: key })
    .onConflictDoNothing({
      target: [userBanners.userId, userBanners.bannerKey],
    })
    .returning({ id: userBanners.id });
  return inserted.length > 0;
}

export async function getOwnedBannerKeys(userId: number): Promise<Set<string>> {
  const rows = await db
    .select({ bannerKey: userBanners.bannerKey })
    .from(userBanners)
    .where(eq(userBanners.userId, userId));
  return new Set(rows.map((row) => row.bannerKey));
}

export async function getOwnedBanners(clerkId: string) {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, selectedBanner: true },
  });
  if (!appUser) return [];

  const rows = await db
    .select({
      bannerKey: userBanners.bannerKey,
      unlockedAt: userBanners.unlockedAt,
      banner: banners,
    })
    .from(userBanners)
    .innerJoin(banners, eq(userBanners.bannerKey, banners.key))
    .where(eq(userBanners.userId, appUser.id))
    .orderBy(asc(banners.sortOrder), asc(banners.id));

  return rows
    .filter((row) => row.banner?.enabled && bannerAssetUrl(row.bannerKey))
    .map((row) => ({
      key: row.bannerKey,
      name: row.banner!.name,
      description: row.banner!.description,
      rarity: row.banner!.rarity,
      equipped: appUser.selectedBanner === row.bannerKey,
      unlockedAt: row.unlockedAt,
      assetUrl: bannerAssetUrl(row.bannerKey),
    }));
}

export type SelectBannerResult =
  | { ok: true; bannerKey: string | null }
  | { ok: false; error: string; status?: number };

export async function selectBanner(
  clerkId: string,
  bannerKey: unknown,
): Promise<SelectBannerResult> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true },
  });
  if (!appUser) return { ok: false, error: "User not found", status: 404 };

  if (bannerKey === null) {
    await db
      .update(users)
      .set({ selectedBanner: null })
      .where(eq(users.id, appUser.id));
    return { ok: true, bannerKey: null };
  }

  const key = normalizeBannerKey(bannerKey);
  if (!key) return { ok: false, error: "Invalid banner key.", status: 400 };

  const catalog = await getBannerByKey(key);
  if (!catalog) return { ok: false, error: "Banner not available.", status: 400 };

  const owned = await db
    .select({ id: userBanners.id })
    .from(userBanners)
    .where(and(eq(userBanners.userId, appUser.id), eq(userBanners.bannerKey, key)))
    .limit(1);
  if (!owned.length) {
    return { ok: false, error: "You do not own this banner.", status: 403 };
  }

  await db
    .update(users)
    .set({ selectedBanner: key })
    .where(eq(users.id, appUser.id));
  return { ok: true, bannerKey: key };
}

export async function resolveSelectedBannerKey(clerkId: string): Promise<string | null> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, selectedBanner: true },
  });
  if (!appUser?.selectedBanner) return null;

  const catalog = await getBannerByKey(appUser.selectedBanner);
  if (!catalog) return null;

  const owned = await db
    .select({ id: userBanners.id })
    .from(userBanners)
    .where(and(eq(userBanners.userId, appUser.id), eq(userBanners.bannerKey, catalog.key)))
    .limit(1);
  return owned.length ? catalog.key : null;
}

/** Grant all banner rewards at or below a Battle Pass level, idempotently. */
export async function grantBattlepassBanners(userId: number, level: number) {
  const { rewardsForLevel } = await import("./battlepassRewards.js");
  const granted: string[] = [];
  const maxLevel = Math.max(1, Math.min(100, Math.floor(Number(level) || 1)));

  for (let rewardLevel = 1; rewardLevel <= maxLevel; rewardLevel += 1) {
    const rewards = rewardsForLevel(rewardLevel);
    if (!Array.isArray(rewards)) continue;
    for (const reward of rewards as Array<{ type?: string; key?: unknown }>) {
      if (reward.type !== "banner") continue;
      const key = normalizeBannerKey(reward.key);
      if (!key) continue;
      const catalog = await getBannerByKey(key);
      if (!catalog) continue;
      if (await unlockBanner(userId, key)) granted.push(key);
    }
  }
  return granted;
}
