// Runtime maintenance-mode flag backed by the app_settings table.
//
// The flag lives in Postgres so it can be flipped instantly from the admin
// dashboard (no redeploy) and survives redeploys. Middleware reads it with a
// short in-memory TTL so a DB round-trip isn't added to every request.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  appSettings,
  MAINTENANCE_MODE_KEY,
  MAINTENANCE_MODE_OFF,
  MAINTENANCE_MODE_ON,
} from "../../db/schema";

const CACHE_TTL_MS = 10_000;

let cache: { value: boolean; expiresAt: number } | null = null;

function readCached(): boolean | null {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  cache = null;
  return null;
}

function writeCache(value: boolean) {
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
}

/**
 * True when maintenance mode is active. Fails open (returns false) if the
 * flag cannot be read — a DB hiccup must never take the whole site down,
 * and a pre-migration deploy treats the table as "not in maintenance".
 */
export async function isMaintenanceMode(): Promise<boolean> {
  const cached = readCached();
  if (cached !== null) return cached;

  try {
    const row = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, MAINTENANCE_MODE_KEY))
      .limit(1)
      .then((rows) => rows[0]);

    const on = row?.value === MAINTENANCE_MODE_ON;
    writeCache(on);
    return on;
  } catch (err) {
    console.warn("[maintenance] flag lookup failed, treating as off:", (err as Error).message);
    return false;
  }
}

/** Flip the maintenance flag and invalidate the cache immediately. */
export async function setMaintenanceMode(on: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: MAINTENANCE_MODE_KEY, value: on ? MAINTENANCE_MODE_ON : MAINTENANCE_MODE_OFF })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: on ? MAINTENANCE_MODE_ON : MAINTENANCE_MODE_OFF, updatedAt: new Date() },
    });
  cache = null;
}
