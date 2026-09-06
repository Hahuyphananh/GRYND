// src/lib/glows.ts
//
// Central authority for OFFICIAL Grynd name glows. Mirrors src/lib/icons.ts
// (catalog + ownership + equip pattern), but the equippable value is a
// fixed catalog color rendered on the user's name.
//
// Rules enforced here (server-side only):
//   * An equipped glow must resolve through the official `glows` catalog.
//   * A glow may only be equipped if the user OWNS it (a row in
//     `user_glows`) and it is enabled.
//   * There is no implicit default glow — NULL selected_glow = no glow
//     (glows are battlepass-earned, never granted by default).
//   * Arbitrary hex colors / user-supplied values are NEVER accepted as a
//     glow (the Grynd+ `chat_color` picker is the free-form surface; glows
//     are fixed catalog entries).
//
// The server is the only writer of `users.selected_glow` (through
// selectGlow).

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { glows, userGlows, users } from "../db/schema";

export const GLOW_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,119}$/;

/** A row from the official `glows` catalog. */
export type GlowRow = typeof glows.$inferSelect;

export type GlowCatalogRow = GlowRow;

/** Look up a single catalog row by key (null when absent or disabled). */
export async function getGlowByKey(key: string): Promise<GlowCatalogRow | null> {
  const [row] = await db
    .select()
    .from(glows)
    .where(and(eq(glows.key, key), eq(glows.enabled, true)))
    .limit(1);
  return row ?? null;
}

/** All enabled catalog rows (includes disabled=false filter). */
export async function getEnabledGlows(): Promise<GlowCatalogRow[]> {
  return db
    .select()
    .from(glows)
    .where(eq(glows.enabled, true))
    .orderBy(glows.sortOrder, glows.id);
}

/**
 * Idempotently grant ownership of `glowKey` to `userId`. Returns true when a
 * new ownership row was created, false when already owned. Does not validate
 * that the glow exists in the catalog (callers grant curated keys).
 */
export async function unlockGlow(userId: number, glowKey: string): Promise<boolean> {
  const existing = await db
    .select({ id: userGlows.id })
    .from(userGlows)
    .where(and(eq(userGlows.userId, userId), eq(userGlows.glowKey, glowKey)))
    .limit(1);
  if (existing.length) return false;
  await db.insert(userGlows).values({ userId, glowKey });
  return true;
}

/**
 * All glows a user owns, joined with their catalog metadata. Order is
 * deterministic (catalog sort_order) so the picker never shuffles.
 */
export async function getOwnedGlows(clerkId: string): Promise<
  {
    glowKey: string;
    name: string;
    description: string;
    color: string;
    rarity: string;
    unlockedAt: Date;
    equipped: boolean;
  }[]
> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, selectedGlow: true },
  });
  if (!appUser) return [];

  const rows = await db
    .select({
      glowKey: userGlows.glowKey,
      unlockedAt: userGlows.unlockedAt,
      glow: glows,
    })
    .from(userGlows)
    .innerJoin(glows, eq(userGlows.glowKey, glows.key))
    .where(eq(userGlows.userId, appUser.id))
    .orderBy(asc(glows.sortOrder), asc(glows.id));

  // Skip disabled catalog rows; dedupe defensively.
  const map = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.glow && row.glow.enabled) map.set(row.glowKey, row);
  }

  return Array.from(map.values()).map((row) => ({
    glowKey: row.glowKey,
    name: row.glow!.name,
    description: row.glow!.description,
    color: row.glow!.color,
    rarity: row.glow!.rarity,
    unlockedAt: row.unlockedAt,
    equipped: appUser.selectedGlow === row.glowKey,
  }));
}

export type SelectGlowResult =
  | { ok: true; glowKey: string | null }
  | { ok: false; error: string; status?: number };

/**
 * Server-authoritative equip. Validates, in order:
 *   1. key is well-formed or the explicit "none" sentinel (never accept
 *      arbitrary input — the free-form surface is the Grynd+ chat-color
 *      picker, not glows),
 *   2. glow exists in the official catalog AND is enabled,
 *   3. user owns the glow.
 * Writes `users.selected_glow` (null clears) and returns the safe key.
 */
export async function selectGlow(
  clerkId: string,
  glowKey: unknown,
): Promise<SelectGlowResult> {
  // null / "none" / "" all clear the equipped glow.
  if (glowKey === null || glowKey === undefined) {
    return clearSelectedGlow(clerkId);
  }
  if (typeof glowKey !== "string") {
    return { ok: false, error: "Invalid glow key.", status: 400 };
  }
  const trimmed = glowKey.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") {
    return clearSelectedGlow(clerkId);
  }
  if (!GLOW_KEY_REGEX.test(trimmed)) {
    return { ok: false, error: "Invalid glow key.", status: 400 };
  }

  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true },
  });
  if (!appUser) {
    return { ok: false, error: "User not found", status: 404 };
  }

  const catalog = await getGlowByKey(trimmed);
  if (!catalog) {
    return { ok: false, error: "Glow not available.", status: 400 };
  }

  const owned = await db
    .select({ id: userGlows.id })
    .from(userGlows)
    .where(and(eq(userGlows.userId, appUser.id), eq(userGlows.glowKey, trimmed)))
    .limit(1);

  if (!owned.length) {
    return { ok: false, error: "You do not own this glow.", status: 403 };
  }

  await db
    .update(users)
    .set({ selectedGlow: trimmed })
    .where(eq(users.id, appUser.id));
  return { ok: true, glowKey: trimmed };
}

async function clearSelectedGlow(clerkId: string): Promise<SelectGlowResult> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true },
  });
  if (!appUser) {
    return { ok: false, error: "User not found", status: 404 };
  }
  await db
    .update(users)
    .set({ selectedGlow: null })
    .where(eq(users.id, appUser.id));
  return { ok: true, glowKey: null };
}