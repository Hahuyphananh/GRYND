// src/lib/cosmetics.ts
//
// Central authority for the official Grynd cosmetics catalog — server-owned
// table `cosmetics` (seeded by migration 0156). Mirrors src/lib/glows.ts
// (catalog + ownership + equip pattern), except a cosmetic's equippable
// value is a fixed `visual` payload (cssClass / color) rendered by the
// client.
//
// Rules enforced here (server-side only):
//   * Any equipped cosmetic must resolve through the official catalog AND
//     be owned by the user (a row in `user_cosmetics`).
//   * Only catalog rows with `price_tokens` set are purchasable from the
//     Shop. Unpurchasable rows (e.g. Prestige Aura/Crown with an
//     `unlock_condition`) are granted through battlepass/eligibility.
//   * `unlock_condition` rows (currently `prestige`) additionally require
//     the condition to be met before they can be purchased or equipped.
//   * `users.equipped_cosmetics` is a jsonb map of category → cosmetic key;
//     it is written ONLY through the equip/clear functions here.
//   * Spends are a single atomic debit + ledger row (`spend`,
//     reference_type `cosmetic`) — same discipline as the shop item buys.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { cosmetics, userCosmetics, users, tokenTransactions } from "../db/schema";

export const COSMETIC_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,119}$/;

// Categories that map 1:1 onto `equipped_cosmetics` slots.
export const COSMETIC_CATEGORIES = [
  "profile_frame",
  "badge",
  "avatar_effect",
  "username_effect",
  "chat_effect",
  "profile_glow",
  "prestige_effect",
] as const;

export type CosmeticCategory = (typeof COSMETIC_CATEGORIES)[number];

/** A row from the official `cosmetics` catalog. */
export type CosmeticRow = typeof cosmetics.$inferSelect;

/** All enabled catalog rows (deterministic sort_order). */
export async function getEnabledCosmetics(): Promise<CosmeticRow[]> {
  return db
    .select()
    .from(cosmetics)
    .where(eq(cosmetics.enabled, true))
    .orderBy(asc(cosmetics.sortOrder), asc(cosmetics.id));
}

/** Catalog rows the Shop can actually sell (they carry a token price). */
export async function getShopCosmetics(): Promise<CosmeticRow[]> {
  return db
    .select()
    .from(cosmetics)
    .where(and(eq(cosmetics.enabled, true), sql`${cosmetics.priceTokens} IS NOT NULL`))
    .orderBy(asc(cosmetics.sortOrder), asc(cosmetics.id));
}

/** Look up a single enabled catalog row by key. */
export async function getCosmeticByKey(key: string): Promise<CosmeticRow | null> {
  const [row] = await db
    .select()
    .from(cosmetics)
    .where(and(eq(cosmetics.key, key), eq(cosmetics.enabled, true)))
    .limit(1);
  return row ?? null;
}

/**
 * Does the user currently satisfy `unlock_condition`? Currently the only
 * condition is `prestige` (prestige progression earned, not purchasable).
 */
export async function meetsUnlockCondition(
  userId: number,
  condition: string | null,
): Promise<boolean> {
  if (!condition) return true;
  if (condition === "prestige") {
    const [row] = await db
      .select({ prestigeLevel: users.prestigeLevel })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return Boolean(row && Number(row.prestigeLevel) >= 1);
  }
  return false;
}

/**
 * Check whether an unlock condition is satisfiable so the Shop can label
 * locked items ("Requires Prestige") without blocking gift-guard purchases.
 * Separate from meetsUnlockCondition to keep the purchase path atomic.
 */

/**
 * Idempotently grant ownership of `key` (validated against the catalog) to
 * `userId`. Returns { granted, alreadyOwned, missing } so battlepass claims
 * can skip cleanly when the catalog is missing a key (never errors).
 */
export async function grantCosmetic(
  userId: number,
  key: string,
  source = "battlepass",
): Promise<{ granted: boolean; alreadyOwned: boolean; missing: boolean }> {
  const catalog = await getCosmeticByKey(key);
  if (!catalog) return { granted: false, alreadyOwned: false, missing: true };

  const existing = await db
    .select({ id: userCosmetics.id })
    .from(userCosmetics)
    .where(and(eq(userCosmetics.userId, userId), eq(userCosmetics.cosmeticKey, key)))
    .limit(1);
  if (existing.length) return { granted: false, alreadyOwned: true, missing: false };

  await db.insert(userCosmetics).values({ userId, cosmeticKey: key, source });
  return { granted: true, alreadyOwned: false, missing: false };
}

export type BuyCosmeticResult =
  | { ok: true; cosmeticKey: string; name: string; balance: number }
  | { ok: false; error: string; status?: number; code?: string };

/**
 * Server-authoritative token purchase of a cosmetic. Validates, in order:
 *   1. key is well-formed,
 *   2. cosmetic exists in the catalog AND is enabled AND has a price,
 *   3. the user exists and has paid enough tokens,
 *   4. the unlock condition (e.g. prestige) is met.
 * Then atomically: debit balance, write the `spend` ledger row, insert the
 * ownership row (unique constraint = idempotency), and return the result.
 */
export async function buyCosmetic(
  clerkId: string,
  key: unknown,
): Promise<BuyCosmeticResult> {
  if (typeof key !== "string" || !COSMETIC_KEY_REGEX.test(key.trim())) {
    return { ok: false, error: "Invalid cosmetic key.", status: 400 };
  }
  const trimmed = key.trim();

  const catalog = await getCosmeticByKey(trimmed);
  const price = catalog?.priceTokens ?? null;
  if (!catalog || price === null || Number(price) <= 0) {
    return { ok: false, error: "Cosmetic not available.", status: 400 };
  }

  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, balance: true },
  });
  if (!appUser) {
    return { ok: false, error: "User not found", status: 404 };
  }
  if (!(await meetsUnlockCondition(appUser.id, catalog.unlockCondition))) {
    return { ok: false, error: "Unlock condition not met.", status: 403 };
  }

  return db.transaction(async (tx) => {
    const balance = Number(appUser.balance ?? 0);
    if (balance < price) {
      return { ok: false, error: "Insufficient balance", status: 400, code: "INSUFFICIENT_BALANCE" };
    }

    await tx
      .update(users)
      .set({ balance: sql`${users.balance} - ${price}` })
      .where(eq(users.id, appUser.id));

    // Ledger — same type/reference shape as the shop-item route.
    await tx.insert(tokenTransactions).values({
      clerkId,
      type: "spend",
      amount: -price,
      referenceType: "cosmetic",
      referenceId: trimmed,
      note: catalog.name,
    });

    await tx
      .insert(userCosmetics)
      .values({ userId: appUser.id, cosmeticKey: trimmed, source: "shop" })
      .onConflictDoNothing({
        target: [userCosmetics.userId, userCosmetics.cosmeticKey],
      });

    return { ok: true, cosmeticKey: trimmed, name: catalog.name, balance: balance - price };
  });
}

export type OwnedCosmetic = {
  key: string;
  name: string;
  description: string;
  category: string;
  rarity: string;
  visual: Record<string, unknown>;
  unlockCondition: string | null;
  unlockedAt: Date;
  equipped: boolean;
};

/**
 * The public profile-frame payload every avatar surface renders. Server-owned:
 * the key, display name and visual all come from the `cosmetics` catalog.
 */
export type ProfileFrame = {
  key: string;
  name: string;
  visual: Record<string, unknown>;
};

/**
 * Pull the equipped profile-frame key out of a raw `users.equipped_cosmetics`
 * jsonb map (category → key). Returns null for anything malformed.
 */
/**
 * Generic equipped-key reader for any cosmetic category slot in the
 * `users.equipped_cosmetics` jsonb map (category → key). Returns null for
 * anything malformed or absent.
 */
export function pickEquippedKey(equipped: unknown, category: string): string | null {
  if (!equipped || typeof equipped !== "object") return null;
  const key = (equipped as Record<string, unknown>)[category];
  return typeof key === "string" && key ? key : null;
}

/** A catalog cosmetic resolved to its public `{ key, name, visual }` shape. */
export type CosmeticRef = {
  key: string;
  name: string;
  visual: Record<string, unknown>;
};

export function pickProfileFrameKey(equipped: unknown): string | null {
  if (!equipped || typeof equipped !== "object") return null;
  const key = (equipped as Record<string, unknown>).profile_frame;
  return typeof key === "string" && key ? key : null;
}

/**
 * Bulk-resolve profile-frame keys to catalog rows. Unknown, disabled or
 * non-frame keys are silently dropped, so a stale equipped key can never
 * render. Used by the batch surfaces (leaderboards, chat) that decorate many
 * players in one query.
 */
/**
 * Bulk-resolve equipped keys for ONE cosmetic category from the enabled
 * catalog. Unknown, disabled or wrong-category keys are silently dropped, so
 * a stale equipped key can never render. The non-frame sibling of
 * getProfileFramesByKeys (avatar / username / chat effects, profile glow).
 */
export async function getCosmeticsByKeysForCategory(
  category: string,
  keys: (string | null | undefined)[],
): Promise<Map<string, CosmeticRef>> {
  const unique = Array.from(
    new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0)),
  );
  const map = new Map<string, CosmeticRef>();
  if (unique.length === 0) return map;

  const rows = await db
    .select({
      key: cosmetics.key,
      name: cosmetics.name,
      category: cosmetics.category,
      visual: cosmetics.visual,
    })
    .from(cosmetics)
    .where(
      and(
        inArray(cosmetics.key, unique),
        eq(cosmetics.enabled, true),
        eq(cosmetics.category, category),
      ),
    );

  for (const row of rows) {
    map.set(row.key, { key: row.key, name: row.name, visual: row.visual });
  }
  return map;
}

/** Resolve a single equipped cosmetic for one category (or null). */
export async function resolveEquippedCosmetic(
  category: string,
  equipped: unknown,
): Promise<CosmeticRef | null> {
  const key = pickEquippedKey(equipped, category);
  if (!key) return null;
  const map = await getCosmeticsByKeysForCategory(category, [key]);
  return map.get(key) ?? null;
}

/**
 * Resolve each equipped map's profile decorations in one pass: the owned
 * profile frame with the equipped avatar effect EMBEDDED on it. Because the
 * effect rides along on the frame payload, any surface that already passes
 * `frame={...}` to <FrameAvatar> renders the avatar effect with no extra
 * plumbing. Returns one entry per input map (null when nothing is equipped).
 */
export type FrameDecoration = {
  key: string | null;
  name: string | null;
  visual: unknown;
  avatarEffect: CosmeticRef | null;
  usernameEffect: CosmeticRef | null;
};

export async function getFrameDecorations(
  equippedList: unknown[],
): Promise<Array<FrameDecoration | null>> {
  const frameKeys = equippedList.map((equipped) => pickProfileFrameKey(equipped));
  const avatarKeys = equippedList.map((equipped) =>
    pickEquippedKey(equipped, "avatar_effect"),
  );
  const usernameKeys = equippedList.map((equipped) =>
    pickEquippedKey(equipped, "username_effect"),
  );
  const [frames, avatars, usernames] = await Promise.all([
    getProfileFramesByKeys(frameKeys),
    getCosmeticsByKeysForCategory("avatar_effect", avatarKeys),
    getCosmeticsByKeysForCategory("username_effect", usernameKeys),
  ]);

  return equippedList.map((_, index) => {
    const frameKey = frameKeys[index];
    const avatarKey = avatarKeys[index];
    const usernameKey = usernameKeys[index];
    const frame = frameKey ? frames.get(frameKey) || null : null;
    const avatarEffect = avatarKey ? avatars.get(avatarKey) || null : null;
    const usernameEffect = usernameKey ? usernames.get(usernameKey) || null : null;
    if (!frame && !avatarEffect && !usernameEffect) return null;
    // A decoration always carries all three fields; the frame fields are null
    // when only an effect is equipped.
    return {
      key: frame?.key ?? null,
      name: frame?.name ?? null,
      visual: frame?.visual ?? null,
      avatarEffect,
      usernameEffect,
    };
  });
}

export async function getProfileFramesByKeys(
  keys: (string | null | undefined)[],
): Promise<Map<string, ProfileFrame>> {
  const unique = Array.from(
    new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0)),
  );
  const map = new Map<string, ProfileFrame>();
  if (unique.length === 0) return map;

  const rows = await db
    .select({
      key: cosmetics.key,
      name: cosmetics.name,
      category: cosmetics.category,
      visual: cosmetics.visual,
    })
    .from(cosmetics)
    .where(
      and(
        inArray(cosmetics.key, unique),
        eq(cosmetics.enabled, true),
        eq(cosmetics.category, "profile_frame"),
      ),
    );

  for (const row of rows) {
    map.set(row.key, { key: row.key, name: row.name, visual: row.visual });
  }
  return map;
}

/** Resolve a single equipped profile frame from a raw equipped map. */
export async function resolveProfileFrame(
  equipped: unknown,
): Promise<FrameDecoration | null> {
  // Full decoration (frame + avatar/username effects) so single-seat callers
  // get the embedded effects too.
  const [decoration] = await getFrameDecorations([equipped]);
  return decoration ?? null;
}

/** All cosmetics a user owns, joined with catalog metadata + equip state. */
export async function getOwnedCosmetics(clerkId: string): Promise<OwnedCosmetic[]> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, equippedCosmetics: true },
  });
  if (!appUser) return [];

  const rows = await db
    .select({
      key: userCosmetics.cosmeticKey,
      unlockedAt: userCosmetics.unlockedAt,
      cosmetic: cosmetics,
    })
    .from(userCosmetics)
    .innerJoin(cosmetics, eq(userCosmetics.cosmeticKey, cosmetics.key))
    .where(eq(userCosmetics.userId, appUser.id))
    .orderBy(asc(cosmetics.sortOrder), asc(cosmetics.id));

  const equipped = appUser.equippedCosmetics || {};
  const map = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.cosmetic && row.cosmetic.enabled) map.set(row.key, row);
  }

  return Array.from(map.values()).map((row) => ({
    key: row.key,
    name: row.cosmetic!.name,
    description: row.cosmetic!.description,
    category: row.cosmetic!.category,
    rarity: row.cosmetic!.rarity,
    visual: row.cosmetic!.visual,
    unlockCondition: row.cosmetic!.unlockCondition,
    unlockedAt: row.unlockedAt,
    equipped: equipped[row.cosmetic!.category] === row.key,
  }));
}

export type EquipCosmeticResult =
  | { ok: true; equippedCosmetics: Record<string, string> }
  | { ok: false; error: string; status?: number };

/**
 * Server-authoritative equip. Accepts a key or null. When null (or "none"),
 * the optional `category` clears that one slot; without a category, clears
 * the whole map. When a key is given the cosmetic must exist, be owned, and
 * its unlock condition met. Writes the whole `equipped_cosmetics` map.
 */
export async function equipCosmetic(
  clerkId: string,
  keyOrNull: unknown,
  categoryArg?: unknown,
): Promise<EquipCosmeticResult> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, equippedCosmetics: true },
  });
  if (!appUser) {
    return { ok: false, error: "User not found", status: 404 };
  }
  const equipped = { ...(appUser.equippedCosmetics || {}) };

  const isClear = keyOrNull === null || keyOrNull === undefined;
  const clearAll = isClear && categoryArg === undefined;
  if (isClear && categoryArg !== null && categoryArg !== undefined) {
    const category = String(categoryArg);
    if (!(COSMETIC_CATEGORIES as readonly string[]).includes(category)) {
      return { ok: false, error: "Invalid category.", status: 400 };
    }
    if (clearAll) {
      // fall through below
    }
    delete equipped[category];
    await db
      .update(users)
      .set({ equippedCosmetics: equipped })
      .where(eq(users.id, appUser.id));
    return { ok: true, equippedCosmetics: equipped };
  }
  if (clearAll) {
    await db
      .update(users)
      .set({ equippedCosmetics: {} })
      .where(eq(users.id, appUser.id));
    return { ok: true, equippedCosmetics: {} };
  }

  if (typeof keyOrNull !== "string" || !COSMETIC_KEY_REGEX.test(keyOrNull.trim())) {
    return { ok: false, error: "Invalid cosmetic key.", status: 400 };
  }
  const key = keyOrNull.trim();

  const catalog = await getCosmeticByKey(key);
  if (!catalog) {
    return { ok: false, error: "Cosmetic not available.", status: 400 };
  }
  if (!(await meetsUnlockCondition(appUser.id, catalog.unlockCondition))) {
    return { ok: false, error: "Unlock condition not met.", status: 403 };
  }

  const owned = await db
    .select({ id: userCosmetics.id })
    .from(userCosmetics)
    .where(and(eq(userCosmetics.userId, appUser.id), eq(userCosmetics.cosmeticKey, key)))
    .limit(1);
  if (!owned.length) {
    return { ok: false, error: "You do not own this cosmetic.", status: 403 };
  }

  equipped[catalog.category] = key;
  await db
    .update(users)
    .set({ equippedCosmetics: equipped })
    .where(eq(users.id, appUser.id));
  return { ok: true, equippedCosmetics: equipped };
}