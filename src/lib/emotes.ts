// src/lib/emotes.ts
//
// Central server authority for the official Grynd animated emote system
// (mirrors src/lib/icons.ts).
//
// Architecture (same pattern as the official icons):
//   * `emotes` catalog table      — enabled keys + official asset paths
//   * `user_emotes` ownership     — one row per (user_id, emote_key)
//   * `users.equipped_emotes`     — ordered JSONB array of equipped keys
//
// Rules enforced here (server-side only — never trust the client):
//   * The 8 FREE emotes are auto-owned by every user (idempotent grant).
//   * A loadout entry must be a well-formed key that resolves through the
//     official catalog, is enabled, AND is owned by the user.
//   * Max 9 entries, no duplicates, order preserved.
//   * GG / NICE MOVE are permanent text system emotes and are NEVER part of
//     the animated catalog or the 9-slot loadout.
//   * The client only ever renders official assets via emoteAssetUrl(key);
//     the server is the only writer of users.equipped_emotes.

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { emotes, userEmotes, users } from "../db/schema";

// Re-export the pure, client-safe helpers so callers have a single import
// surface for emote operations.
export {
  EMOTE_ASSET_DIR,
  EMOTE_ASSET_EXT,
  EMOTE_KEY_MAX_LENGTH,
  EMOTE_KEY_REGEX,
  FREE_EMOTE_KEYS,
  MAX_EQUIPPED_EMOTES,
  OFFICIAL_EMOTE_DEFINITIONS,
  emoteAssetUrl,
  isEmoteKey,
  isTrustedEmoteAssetUrl,
  normalizeEmoteKey,
  resolveDisplayEmoteKey,
} from "./emoteAssets";
import {
  FREE_EMOTE_KEYS,
  MAX_EQUIPPED_EMOTES,
  emoteAssetUrl,
  normalizeEmoteKey,
} from "./emoteAssets";

/** A row from the official `emotes` catalog. */
export type EmoteRow = typeof emotes.$inferSelect;

export type EmoteCatalogRow = EmoteRow;

/** Look up a single catalog row by key (null when absent or disabled). */
export async function getEmoteByKey(key: string): Promise<EmoteCatalogRow | null> {
  const [row] = await db
    .select()
    .from(emotes)
    .where(and(eq(emotes.key, key), eq(emotes.enabled, true)))
    .limit(1);
  return row ?? null;
}

/** All enabled catalog rows, in catalog order. */
export async function getEnabledEmotes(): Promise<EmoteCatalogRow[]> {
  return db
    .select()
    .from(emotes)
    .where(eq(emotes.enabled, true))
    .orderBy(asc(emotes.sortOrder), asc(emotes.id));
}

/**
 * Idempotently grant ownership of `emoteKey` to `userId`. Returns true only
 * when a NEW ownership row was created (false when already owned / no-op).
 */
export async function unlockEmote(userId: number, emoteKey: string): Promise<boolean> {
  const inserted = await db
    .insert(userEmotes)
    .values({ userId, emoteKey })
    .onConflictDoNothing({
      target: [userEmotes.userId, userEmotes.emoteKey],
    })
    .returning({ id: userEmotes.id });
  return inserted.length > 0;
}

/** The default loadout = the FREE emote set (in catalog order, max 9). */
export function defaultLoadoutKeys(): string[] {
  return FREE_EMOTE_KEYS.slice(0, MAX_EQUIPPED_EMOTES);
}

/**
 * Sanitize a raw loadout array:
 *   1. keep only well-formed, officially-catalogued (normalized) keys,
 *   2. drop anything the user does not own,
 *   3. de-duplicate (first occurrence wins, order preserved),
 *   4. cap at MAX_EQUIPPED_EMOTES (9).
 * Also repairs >9 legacy/corrupt rows by retaining only the first 9 valid
 * owned emotes (acceptance: sanitize server-side).
 */
export function sanitizeLoadoutKeys(raw: unknown, ownedKeys: ReadonlySet<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of raw) {
    const key = normalizeEmoteKey(entry);
    if (!key) continue; // well-formed + officially catalogued only
    if (!ownedKeys.has(key)) continue; // ownership is checked server-side
    if (seen.has(key)) continue; // no duplicates
    seen.add(key);
    cleaned.push(key);
    if (cleaned.length >= MAX_EQUIPPED_EMOTES) break; // max 9
  }
  return cleaned;
}

/**
 * Reconcile a user's emote state. Idempotent + safe to run repeatedly:
 *   1. grants the 8 FREE emotes whenever they are missing,
 *   2. seeds the default loadout ONLY on the very first grant (when the
 *      user owned zero emotes and the stored loadout is empty) — a user who
 *      later unequips everything is never re-seeded,
 *   3. sanitizes the stored loadout (dedupe / max-9 / owned-only) and
 *      persists the repaired version when needed.
 * Returns the app user id for callers that still need it.
 */
export async function reconcileEmoteState(userId: number): Promise<void> {
  const ownedRows = await db
    .select({ emoteKey: userEmotes.emoteKey })
    .from(userEmotes)
    .where(eq(userEmotes.userId, userId));
  const ownedKeys = new Set(ownedRows.map((row) => row.emoteKey));
  const hadAnyOwned = ownedKeys.size > 0;

  const missingFree = FREE_EMOTE_KEYS.filter((key) => !ownedKeys.has(key));
  if (missingFree.length > 0) {
    await db
      .insert(userEmotes)
      .values(missingFree.map((key) => ({ userId, emoteKey: key })))
      .onConflictDoNothing({
        target: [userEmotes.userId, userEmotes.emoteKey],
      });
    missingFree.forEach((key) => ownedKeys.add(key));
  }

  const [userRow] = await db
    .select({ id: users.id, equippedEmotes: users.equippedEmotes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!userRow) return;

  const stored = Array.isArray(userRow.equippedEmotes) ? userRow.equippedEmotes : [];

  // First-time grant (user owned ZERO emotes before this call) + empty
  // loadout → seed the default loadout (all free emotes). A user who later
  // deliberately unequips everything owns emotes already, so they are never
  // re-seeded on subsequent reads.
  if (!hadAnyOwned && missingFree.length > 0 && stored.length === 0) {
    await db
      .update(users)
      .set({ equippedEmotes: defaultLoadoutKeys() })
      .where(eq(users.id, userId));
    return;
  }

  // Sanitize + repair whenever the stored value drifted (corrupt/legacy).
  const cleaned = sanitizeLoadoutKeys(stored, ownedKeys);
  if (cleaned.length !== stored.length || cleaned.some((key, index) => stored[index] !== key)) {
    await db.update(users).set({ equippedEmotes: cleaned }).where(eq(users.id, userId));
  }
}

async function resolveUserId(clerkId: string): Promise<number | null> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true },
  });
  return appUser?.id ?? null;
}

/** Set of emote keys the user currently owns. */
export async function getOwnedEmoteKeys(userId: number): Promise<Set<string>> {
  const rows = await db
    .select({ emoteKey: userEmotes.emoteKey })
    .from(userEmotes)
    .where(eq(userEmotes.userId, userId));
  return new Set(rows.map((row) => row.emoteKey));
}

/**
 * The user's effective equipped loadout (ordered array of validated owned
 * emote keys, max 9). Reconciles free ownership + seeds defaults + repairs
 * legacy data first, so the result is always consistent for the picker.
 */
export async function getEquippedEmoteKeys(clerkId: string): Promise<string[]> {
  const userId = await resolveUserId(clerkId);
  if (!userId) return [];
  await reconcileEmoteState(userId);
  const [userRow] = await db
    .select({ equippedEmotes: users.equippedEmotes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const ownedKeys = await getOwnedEmoteKeys(userId);
  return sanitizeLoadoutKeys(userRow?.equippedEmotes, ownedKeys);
}

/** Battle Pass level → emote key map for every emote reward in the track. */
export async function battlepassEmoteRewardMap(): Promise<Map<number, string>> {
  const { rewardsForLevel } = await import("./battlepassRewards.js");
  const map = new Map<number, string>();
  for (let level = 1; level <= 100; level += 1) {
    const rewards = rewardsForLevel(level);
    if (!Array.isArray(rewards)) continue;
    for (const reward of rewards as Array<{ type?: string; key?: unknown }>) {
      if (reward.type === "emote" && typeof reward.key === "string") {
        map.set(level, reward.key);
      }
    }
  }
  return map;
}

/**
 * Battle Pass level keyed by emote key (used to tell players where a locked
 * emote unlocks). Built from the single battlepass rewards config.
 */
async function battlepassEmoteLevelByKeyMap(): Promise<Map<string, number>> {
  const map = await battlepassEmoteRewardMap();
  const byKey = new Map<string, number>();
  for (const [level, key] of map.entries()) byKey.set(key, level);
  return byKey;
}

/**
 * Grant every emote Battle Pass reward at or below `level`, idempotently
 * (duplicate grants are no-ops via the user_emotes unique constraint).
 * Called from the same Battle Pass reconciliation points as the title /
 * glow grants (addExp, the /api/battlepass page load, and the leaderboard
 * counters). An emote that unlocks becomes OWNED but is never
 * auto-equipped — the player chooses to add it to their loadout.
 */
export async function grantBattlepassEmotes(userId: number, level: number) {
  const { rewardsForLevel } = await import("./battlepassRewards.js");
  const granted: string[] = [];
  const maxLevel = Math.max(1, Math.min(100, Math.floor(Number(level) || 1)));

  for (let rewardLevel = 1; rewardLevel <= maxLevel; rewardLevel += 1) {
    const rewards = rewardsForLevel(rewardLevel);
    if (!Array.isArray(rewards)) continue;
    for (const reward of rewards as Array<{ type?: string; key?: unknown }>) {
      if (reward.type !== "emote") continue;
      const key = normalizeEmoteKey(reward.key);
      if (!key) continue;
      const catalog = await getEmoteByKey(key);
      if (!catalog) continue;
      if (await unlockEmote(userId, key)) granted.push(key);
    }
  }
  return granted;
}

export type EmoteStateEmote = {
  key: string;
  name: string;
  description: string;
  rarity: string;
  sortOrder: number;
  owned: boolean;
  equipped: boolean;
  /** Battle Pass level this emote unlocks at (null when not a BP reward). */
  unlockLevel: number | null;
  assetUrl: string;
};

/**
 * Full emote state for the profile manager + game picker:
 *   * every enabled catalog emote with ownership / equipped flags and
 *     Battle Pass unlock info for locked entries,
 *   * the ordered equipped loadout (already sanitized server-side).
 */
export async function getEmoteState(clerkId: string): Promise<{
  equippedEmotes: string[];
  emotes: EmoteStateEmote[];
} | null> {
  const userId = await resolveUserId(clerkId);
  if (!userId) return null;

  await reconcileEmoteState(userId);

  const [userRow] = await db
    .select({ equippedEmotes: users.equippedEmotes })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const ownedRows = await db
    .select({ emoteKey: userEmotes.emoteKey })
    .from(userEmotes)
    .where(eq(userEmotes.userId, userId));
  const ownedKeys = new Set(ownedRows.map((row) => row.emoteKey));
  const equippedKeys = sanitizeLoadoutKeys(userRow?.equippedEmotes, ownedKeys);
  const equippedSet = new Set(equippedKeys);

  const catalog = await getEnabledEmotes();
  const levelByKey = await battlepassEmoteLevelByKeyMap();
  const emotesOut: EmoteStateEmote[] = catalog.map((row) => ({
    key: row.key,
    name: row.name,
    description: row.description,
    rarity: row.rarity,
    sortOrder: row.sortOrder,
    owned: ownedKeys.has(row.key),
    equipped: equippedSet.has(row.key),
    unlockLevel: levelByKey.get(row.key) ?? null,
    assetUrl: emoteAssetUrl(row.key) ?? row.assetPath,
  }));

  return { equippedEmotes: equippedKeys, emotes: emotesOut };
}

export type SetLoadoutResult =
  | { ok: true; equippedEmotes: string[] }
  | { ok: false; error: string; status?: number };

/**
 * Server-authoritative full-loadout write. Accepts the COMPLETE desired
 * ordered list in one request and validates, in order:
 *   1. the body is an array of strings (rejects anything else),
 *   2. every key is well-formed AND exists in the official catalog AND is
 *      enabled (getEmoteByKey),
 *   3. every key is actually owned by the user (user_emotes),
 *   4. no duplicate keys,
 *   5. max 9 entries.
 * Saves the sanitized array atomically (single JSONB UPDATE). The client can
 * never claim an emote it does not own, can never smuggle a non-catalog key,
 * and can never exceed 9 slots.
 */
export async function setEquippedEmotes(
  clerkId: string,
  rawKeys: unknown
): Promise<SetLoadoutResult> {
  const userId = await resolveUserId(clerkId);
  if (!userId) return { ok: false, error: "User not found", status: 404 };

  if (!Array.isArray(rawKeys)) {
    return { ok: false, error: "Send an array of emote keys.", status: 400 };
  }
  if (rawKeys.some((key) => typeof key !== "string")) {
    return { ok: false, error: "Emote keys must be strings.", status: 400 };
  }
  if (rawKeys.length > MAX_EQUIPPED_EMOTES) {
    return {
      ok: false,
      error: `You can equip a maximum of ${MAX_EQUIPPED_EMOTES} emotes.`,
      status: 400,
    };
  }

  await reconcileEmoteState(userId);
  const ownedKeys = await getOwnedEmoteKeys(userId);
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawKey of rawKeys) {
    const key = normalizeEmoteKey(rawKey);
    if (!key) {
      return { ok: false, error: "Unknown emote.", status: 400 };
    }
    if (seen.has(key)) {
      return { ok: false, error: "Duplicate emote keys are not allowed.", status: 400 };
    }
    seen.add(key);
    const catalog = await getEmoteByKey(key);
    if (!catalog) {
      return { ok: false, error: "Emote not available.", status: 400 };
    }
    if (!ownedKeys.has(key)) {
      return { ok: false, error: "You do not own this emote.", status: 403 };
    }
    normalized.push(key);
  }

  await db.update(users).set({ equippedEmotes: normalized }).where(eq(users.id, userId));

  return { ok: true, equippedEmotes: normalized };
}
