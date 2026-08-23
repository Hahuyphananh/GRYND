import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

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
    console.warn(
      "[redis] Missing KV_REST_API_URL / KV_REST_API_TOKEN. " +
        "Redis caching is disabled. Queries will hit the database directly.",
    );
    return null;
  }

  redis = new Redis({ url, token });
  return redis;
}

/**
 * Safe wrapper that returns null when Redis is unavailable.
 */
export async function withRedis<T>(
  fn: (r: Redis) => Promise<T>,
): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return await fn(r);
  } catch (err) {
    console.error("[redis] Operation failed:", err);
    return null;
  }
}
