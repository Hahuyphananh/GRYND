"use client";

/**
 * localStorage-backed cache provider for SWR.
 *
 * Why: a list that paints instantly from cache and refreshes in the
 * background feels far faster than anything you can do to the API. SWR
 * already gives us stale-while-revalidate semantics in memory; this provider
 * persists those entries across reloads and app launches (the app is also
 * shipped as a Capacitor PWA, where a cold start is the common case).
 *
 * Design notes:
 *   - Values are JSON. SWR only writes successful, JSON-serializable fetcher
 *     results, so this is lossless for our `/api` GETs.
 *   - Entries older than MAX_AGE_MS are dropped on hydrate, so a stale cache
 *     can never outlive a day.
 *   - The store is pruned to MAX_ENTRIES (oldest first) to bound localStorage
 *     usage; a write that blows the quota drops the oldest half and retries
 *     once instead of throwing.
 *   - User-scoped endpoints (balance, stats, friends, history, purchases…)
 *     are kept in memory only. They still get instant within-session caching
 *     and background refresh, but are never written to disk — so a shared
 *     device can't surface one player's balance (or history) to the next.
 *   - SSR-safe: with no `window`, the provider is a plain in-memory Map.
 */

export const CACHE_PREFIX = "grynd:swr:";

const MAX_ENTRIES = 200;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Anything user-scoped: cached in memory, never persisted to disk.
const SENSITIVE_PATTERN =
  /(get-user-tokens|user\/stats|user-stats|user\/glows|prestige-badge|membership\/status|\/friends|friend|invites|get-bet-history|get-purchase-history|\/titles|cosmetics|referral|chat-color|profile-customization)/i;

/** True when a SWR key may be written to localStorage. */
export function isPersistableKey(key) {
  if (typeof key !== "string" || !key) return false;
  return !SENSITIVE_PATTERN.test(key);
}

function getStorage() {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    // Touch it — Safari private mode used to throw on setItem.
    const probe = `${CACHE_PREFIX}probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function readEntry(storage, storageKey) {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const age = Date.now() - Number(parsed.t || 0);
    if (!Number.isFinite(age) || age > MAX_AGE_MS) {
      storage.removeItem(storageKey);
      return undefined;
    }
    return parsed.v;
  } catch {
    return undefined;
  }
}

function pruneToLimit(storage, max) {
  try {
    const entries = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      let t = 0;
      try {
        t = Number(JSON.parse(storage.getItem(key) || "{}").t || 0);
      } catch {
        t = 0;
      }
      entries.push({ key, t });
    }
    if (entries.length <= max) return;
    entries
      .sort((a, b) => a.t - b.t)
      .slice(0, entries.length - max)
      .forEach(({ key }) => storage.removeItem(key));
  } catch {
    // Storage unavailable — nothing to prune.
  }
}

/**
 * SWR cache provider. Pass as `provider: createPersistentSwrCache` to
 * `<SWRConfig>`; SWR calls it once per config to build the store.
 */
export function createPersistentSwrCache() {
  const memory = new Map();
  const storage = getStorage();

  // Hydrate from disk so the first render already has data.
  if (storage) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const storageKey = storage.key(i);
        if (!storageKey || !storageKey.startsWith(CACHE_PREFIX)) continue;
        const value = readEntry(storage, storageKey);
        if (value !== undefined) {
          memory.set(storageKey.slice(CACHE_PREFIX.length), value);
        }
      }
    } catch {
      // Corrupt/unavailable storage: start empty rather than crash.
    }
  }

  const writeToDisk = (rawKey, value) => {
    if (!storage || !isPersistableKey(rawKey)) return;
    const storageKey = `${CACHE_PREFIX}${rawKey}`;
    try {
      storage.setItem(storageKey, JSON.stringify({ t: Date.now(), v: value }));
      pruneToLimit(storage, MAX_ENTRIES);
    } catch {
      // Likely QuotaExceededError — drop the oldest half and retry once.
      try {
        pruneToLimit(storage, Math.floor(MAX_ENTRIES / 2));
        storage.setItem(
          storageKey,
          JSON.stringify({ t: Date.now(), v: value }),
        );
      } catch {
        // Give up on persistence for this key; memory cache still works.
      }
    }
  };

  return {
    get(key) {
      return memory.get(key);
    },
    set(key, value) {
      memory.set(key, value);
      writeToDisk(key, value);
    },
    delete(key) {
      memory.delete(key);
      if (!storage) return;
      try {
        storage.removeItem(`${CACHE_PREFIX}${key}`);
      } catch {
        // ignore
      }
    },
    keys() {
      return memory.keys();
    },
  };
}

/**
 * When a persisted key was last written, so a screen can say "updated 4 min
 * ago" while it serves cached data. Returns null for keys that were never
 * persisted (user-scoped keys, first visit, or an offline cold start).
 */
export function getCacheTimestamp(key) {
  const storage = getStorage();
  if (!storage || !isPersistableKey(key)) return null;
  try {
    const raw = storage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const t = Number(parsed?.t);
    return Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Wipe every persisted entry — called from logout hygiene. */
export function clearPersistentCache() {
  const storage = getStorage();
  if (!storage) return;
  try {
    const doomed = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) doomed.push(key);
    }
    doomed.forEach((key) => storage.removeItem(key));
  } catch {
    // ignore
  }
}
