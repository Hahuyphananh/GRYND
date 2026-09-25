import { withRedis } from "./client";

// ── Cache stats (in-memory counters) ─────────────────────────────

interface CacheStats {
  hits: number;
  misses: number;
  forceFresh: number;
  sets: number;
  deletes: number;
}

const _stats: Record<string, CacheStats> = {};
const _ALL = "__all__";

function _ensureDomain(domain: string): CacheStats {
  if (!_stats[domain]) {
    _stats[domain] = { hits: 0, misses: 0, forceFresh: 0, sets: 0, deletes: 0 };
  }
  return _stats[domain];
}

function _extractDomain(key: string): string {
  // Extract the second colon-separated segment as the domain.
  // grynd:lb:all-time:...  → "lb"
  // grynd:user:stats:...   → "user"
  // grynd:recent-games:... → "recent-games"
  const parts = key.split(":");
  return parts.length >= 3 ? parts[1] : parts[0] || "unknown";
}

function _increment(domain: string, field: keyof CacheStats): void {
  const all = _ensureDomain(_ALL);
  all[field]++;
  const d = _ensureDomain(domain);
  d[field]++;
}

/** Return a snapshot of current cache stats. */
export function getCacheStats(): Record<string, CacheStats> {
  // Return a shallow copy so callers can't mutate the live counters.
  return { ..._stats };
}

/** Reset all in-memory stats. */
export function resetCacheStats(): void {
  for (const key of Object.keys(_stats)) {
    delete _stats[key];
  }
}

// ── Logging helpers ──────────────────────────────────────────────

const VERBOSE =
  (typeof process !== "undefined" &&
    process.env?.CACHE_VERBOSE_LOGGING === "1") ||
  false;

const LOG_FILTER: string | null =
  (typeof process !== "undefined" && process.env?.CACHE_LOG_FILTER) || null;

function _shouldLog(key: string): boolean {
  if (!VERBOSE) return false;
  if (!LOG_FILTER) return true;
  return key.includes(LOG_FILTER);
}

function _logHit(key: string): void {
  if (_shouldLog(key)) console.log(`[cache] HIT  ${key}`);
}

function _logMiss(key: string): void {
  if (_shouldLog(key)) console.log(`[cache] MISS ${key}`);
}

function _logForceFresh(key: string): void {
  if (_shouldLog(key)) console.log(`[cache] FRESH-FORCED ${key}`);
}

// ── Core cache primitives ────────────────────────────────────────

/**
 * Fetch a value from cache by key.
 * Returns `null` on miss, Redis error, or when Redis is unavailable.
 */
export async function cacheGet<T = unknown>(
  key: string,
): Promise<T | null> {
  return withRedis(async (redis) => {
    const raw = await redis.get<string>(key);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  });
}

/**
 * Store a value in cache with optional TTL (seconds).
 * Uses "SET key value EX ttl" semantics.
 * Skips silently when Redis is unavailable.
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  await withRedis(async (redis) => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    await redis.set(key, serialized, { ex: ttlSeconds });
    _increment(_extractDomain(key), "sets");
  });
}

/**
 * Delete one or more cache keys.
 * Skips silently when Redis is unavailable.
 */
export async function cacheDelete(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await withRedis(async (redis) => {
    await redis.del(...keys);
  });
  for (const key of keys) {
    _increment(_extractDomain(key), "deletes");
  }
}

/**
 * Delete all keys matching a glob-style pattern.
 *
 * Uses the SCAN + DEL approach to avoid blocking Redis.
 * Upstash supports the KEYS command but SCAN is safer.
 */
export async function cacheDeletePattern(pattern: string): Promise<void> {
  await withRedis(async (redis) => {
    let cursor: string = "0";
    const keysToDelete: string[] = [];

    do {
      const [nextCursor, batch] = await redis.scan(cursor, {
        match: pattern,
        count: 100,
      });
      cursor = nextCursor;
      keysToDelete.push(...batch);
    } while (cursor !== "0");

    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
      // Track deletes per domain
      for (const key of keysToDelete) {
        _increment(_extractDomain(key), "deletes");
      }
    }
  });
}

/**
 * Cache-or-fetch pattern: tries cache first, calls `fetcher` on miss,
 * stores the result, and returns it.
 *
 * @param key       Cache key
 * @param ttlSec    Backup TTL in seconds (event-driven invalidation is primary)
 * @param fetcher   Async function to call on cache miss
 * @param options   Optional behavior flags
 */
export async function cacheOrFetch<T>(
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T>,
  options: { forceFresh?: boolean } = {},
): Promise<T> {
  if (!options.forceFresh) {
    const cached = await cacheGet<T>(key);
    if (cached !== null) {
      _increment(_extractDomain(key), "hits");
      _logHit(key);
      return cached;
    }
    _increment(_extractDomain(key), "misses");
    _logMiss(key);
  } else {
    _increment(_extractDomain(key), "forceFresh");
    _logForceFresh(key);
  }

  const fresh = await fetcher();

  // Fire-and-forget: store in cache, don't block on it
  cacheSet(key, fresh, ttlSec).catch(() => {});

  return fresh;
}
