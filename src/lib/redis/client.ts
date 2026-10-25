import { Redis } from "@upstash/redis";
import { withTimeout } from "../security/withTimeout";

/**
 * Hard ceiling on ONE Redis (Upstash REST) call.
 *
 * Upstash is reached over HTTPS through `fetch`, and nothing in that stack gives
 * an outbound request a deadline: Node's fetch has none, and the SDK's own retry
 * loop only reacts to errors. When the endpoint is BLACKHOLED — a wrong host, a
 * blocked egress rule, or a VM whose DNS/security list does not yet allow it,
 * which is the state a freshly migrated box is in — the promise never settles.
 * The request that awaited it then never sends a byte, never logs, and simply
 * hangs: "TCP accepted, no HTTP response".
 *
 * That is not a cache problem. `withRedis` backs the page path too: src/proxy.ts
 * reads the user's MFA and age flags from this cache before it lets a route
 * render, so one unreachable cache turns EVERY page into that hang.
 *
 * 1.5s is far above a healthy Upstash round-trip (single-digit ms) and far below
 * anything a player would tolerate. On timeout the operation throws, and every
 * caller already degrades the documented way: cache reads miss, rate limiting
 * falls back to memory, MFA bookkeeping uses its in-memory map.
 */
export const REDIS_TIMEOUT_MS = 1_500;

let redis: Redis | null = null;

// cacheGet/cacheSet no-op when Redis isn't configured, which is the normal
// state in dev. Warn once instead of on every call so a page load doesn't
// spam N identical "Redis disabled" lines.
let warnedAboutMissingConfig = false;

/**
 * Returns the shared Redis client.
 * Falls back to null when KV_REST_API_URL / KV_REST_API_TOKEN
 * are not configured so the app runs without Redis.
 */
export function getRedis(): Redis | null {
  if (redis) return redis;

  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;

  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (!warnedAboutMissingConfig) {
      warnedAboutMissingConfig = true;
      console.warn(
        "[redis] Missing KV_REST_API_URL / KV_REST_API_TOKEN. " +
          "Redis caching is disabled. Queries will hit the database directly.",
      );
    }
    return null;
  }

  redis = new Redis({
    url,
    token,
    // The SDK calls a factory signal ONCE PER REQUEST (nodejs.js:
    // `signal: isSignalFunction ? signal() : signal`), so every command gets
    // its own fresh deadline. It also stops its retry loop the moment that
    // signal aborts, so a blackholed endpoint costs one timeout, not five.
    signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
  return redis;
}

/**
 * Safe wrapper that returns null when Redis is unavailable.
 *
 * The race is deliberate belt-and-braces: the client's own signal aborts the
 * socket, and this guarantees the AWAITING request is released even if a
 * transport ignores the signal (a custom agent, a future SDK change).
 */
export async function withRedis<T>(
  fn: (r: Redis) => Promise<T>,
): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return await withTimeout(fn(r), REDIS_TIMEOUT_MS, null);
  } catch (err) {
    console.error("[redis] Operation failed:", err);
    return null;
  }
}
