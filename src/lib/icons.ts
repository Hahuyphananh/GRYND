// src/lib/icons.ts
//
// Central authority for OFFICIAL Grynd icons. Mirrors src/lib/specialTitles.ts
// (ownership pattern) + re-exports the pure asset helpers from
// src/lib/iconAssets.ts (profileCosmetics.ts pattern).
//
// Rules enforced here (server-side only):
//   * An equipped icon must resolve through the official `icons` catalog.
//   * A non-default icon may only be equipped if the user OWNS it
//     (a row in `user_icons`) and it is enabled.
//   * The default icon is implicitly owned by every user (granted on account
//     creation and backfilled by migration 0128).
//   * Arbitrary URLs / user-supplied media are NEVER accepted as an icon.
//
// The client only ever renders official assets via `iconAssetUrl(key)`; the
// server is the only writer of `users.selected_icon` (through selectIcon).

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { icons, userIcons, users } from "../db/schema";

// Re-export the pure, client-safe helpers so callers have a single import
// surface for icon operations.
export {
  DEFAULT_ICON_KEY,
  ICON_ASSET_DIR,
  ICON_ASSET_EXT,
  ICON_KEY_MAX_LENGTH,
  ICON_KEY_REGEX,
  defaultIconAssetUrl,
  iconAssetUrl,
  isIconKey,
  resolveDisplayIconKey,
} from "./iconAssets";

/** A row from the official `icons` catalog. */
export type IconRow = typeof icons.$inferSelect;

export type IconCatalogRow = IconRow;

/** Look up a single catalog row by key (null when absent or disabled). */
export async function getIconByKey(key: string): Promise<IconCatalogRow | null> {
  const [row] = await db
    .select()
    .from(icons)
    .where(and(eq(icons.key, key), eq(icons.enabled, true)))
    .limit(1);
  return row ?? null;
}

/** All enabled catalog rows (includes disabled=false filter). */
export async function getEnabledIcons(): Promise<IconCatalogRow[]> {
  return db
    .select()
    .from(icons)
    .where(eq(icons.enabled, true))
    .orderBy(icons.sortOrder, icons.id);
}

/** Set of enabled icon keys — used for fast membership checks. */
export async function getEnabledIconKeys(): Promise<Set<string>> {
  const rows = await db.select({ key: icons.key }).from(icons).where(eq(icons.enabled, true));
  return new Set(rows.map((r) => r.key));
}

/**
 * Idempotently grant ownership of `iconKey` to `userId`. Returns true when a
 * new ownership row was created, false when already owned. Does not validate
 * that the icon exists in the catalog (callers grant curated keys).
 */
export async function unlockIcon(userId: number, iconKey: string): Promise<boolean> {
  const existing = await db
    .select({ id: userIcons.id })
    .from(userIcons)
    .where(and(eq(userIcons.userId, userId), eq(userIcons.iconKey, iconKey)))
    .limit(1);
  if (existing.length) return false;
  await db.insert(userIcons).values({ userId, iconKey });
  return true;
}

/** Ensure the user owns the official default icon (idempotent). */
export async function grantDefaultIcon(userId: number): Promise<boolean> {
  return unlockIcon(userId, "default");
}

/**
 * Ensure the user owns every enabled official icon (idempotent). Used at
 * account creation so new users start with the same full catalog as existing
 * users (migration 0129 backfills ownership for pre-existing accounts).
 */
export async function grantAllOfficialIcons(userId: number): Promise<void> {
  const keys = await getEnabledIconKeys();
  for (const key of keys) {
    await unlockIcon(userId, key);
  }
}

/**
 * All icons a user owns, joined with their catalog metadata. Also ensures the
 * default icon is always included (every user implicitly owns it).
 */
export async function getOwnedIcons(clerkId: string): Promise<
  { iconKey: string; name: string; description: string; rarity: string; assetPath: string; isDefault: boolean; unlockedAt: Date; equipped: boolean }[]
> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true, selectedIcon: true },
  });
  if (!appUser) return [];

  await grantDefaultIcon(appUser.id);

  const ownedRows = await db
    .select({
      iconKey: userIcons.iconKey,
      unlockedAt: userIcons.unlockedAt,
      icon: icons,
    })
    .from(userIcons)
    .innerJoin(icons, eq(userIcons.iconKey, icons.key))
    .where(eq(userIcons.userId, appUser.id));

  // Build a map so duplicates can't appear; skip disabled catalog rows.
  const map = new Map<string, (typeof ownedRows)[number]>();
  for (const row of ownedRows) {
    if (row.icon && row.icon.enabled) map.set(row.iconKey, row);
  }

  // Ensure the default is present even if its catalog row was removed.
  if (!map.has("default")) {
    return [
      {
        iconKey: "default",
        name: "Default",
        description: "The official default Grynd icon.",
        rarity: "Common",
        assetPath: "/icons/default.webp",
        isDefault: true,
        unlockedAt: new Date(),
        equipped: appUser.selectedIcon === "default",
      },
    ];
  }

  return Array.from(map.values()).map((row) => ({
    iconKey: row.iconKey,
    name: row.icon!.name,
    description: row.icon!.description,
    rarity: row.icon!.rarity,
    assetPath: row.icon!.assetPath,
    isDefault: Boolean(row.icon!.isDefault),
    unlockedAt: row.unlockedAt,
    equipped: appUser.selectedIcon === row.iconKey,
  }));
}

/**
 * Resolve the effective (safe, enabled) icon key a user should display.
 * Fallback order: malformed → default; disabled/absent from catalog → default.
 */
export async function resolveSelectedIconKey(clerkId: string): Promise<string> {
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { selectedIcon: true },
  });

  let raw = appUser?.selectedIcon ?? null;
  if (typeof raw !== "string" || !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(raw)) {
    return "default";
  }
  if (raw === "default") return "default";

  const exists = await getIconByKey(raw);
  return exists ? raw : "default";
}

export type SelectIconResult =
  | { ok: true; iconKey: string }
  | { ok: false; error: string; status?: number };

/**
 * Server-authoritative equip. Validates, in order:
 *   1. key is well-formed (never accept arbitrary input),
 *   2. icon exists in the official catalog AND is enabled,
 *   3. user owns the icon (default is implicitly owned / granted).
 * Writes `users.selected_icon` and returns the safe key.
 */
export async function selectIcon(clerkId: string, iconKey: unknown): Promise<SelectIconResult> {
  if (typeof iconKey !== "string" || !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(iconKey.trim())) {
    return { ok: false, error: "Invalid icon key.", status: 400 };
  }

  const safeKey = iconKey.trim();
  const appUser = await db.query.users.findFirst({
    where: eq(users.clerkId, clerkId),
    columns: { id: true },
  });
  if (!appUser) {
    return { ok: false, error: "User not found", status: 404 };
  }

  // Default is always equipable (granted implicitly).
  if (safeKey === "default") {
    await grantDefaultIcon(appUser.id);
    await db.update(users).set({ selectedIcon: safeKey }).where(eq(users.id, appUser.id));
    return { ok: true, iconKey: safeKey };
  }

  const catalog = await getIconByKey(safeKey);
  if (!catalog) {
    return { ok: false, error: "Icon not available.", status: 400 };
  }

  const owned = await db
    .select({ id: userIcons.id })
    .from(userIcons)
    .where(and(eq(userIcons.userId, appUser.id), eq(userIcons.iconKey, safeKey)))
    .limit(1);

  if (!owned.length) {
    return { ok: false, error: "You do not own this icon.", status: 403 };
  }

  await db.update(users).set({ selectedIcon: safeKey }).where(eq(users.id, appUser.id));
  return { ok: true, iconKey: safeKey };
}