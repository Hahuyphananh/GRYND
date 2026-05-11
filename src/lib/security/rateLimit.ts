export type LimitConfig = {
  windowMs: number;
  max: number;
};

type Entry = {
  count: number;
  resetAt: number;
};

type LimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
};

const store = new Map<string, Entry>();

function getRemoteRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) return null;

  return {
    url: url.replace(/\/+$/, ""),
    token,
  };
}

async function consumeRemoteRateLimit(
  key: string,
  config: LimitConfig,
): Promise<LimitResult | null> {
  const redis = getRemoteRedisConfig();
  if (!redis) return null;

  const encodedKey = encodeURIComponent(`ratelimit:${key}`);
  const ttlSeconds = Math.max(Math.ceil(config.windowMs / 1000), 1);

  const headers = {
    Authorization: `Bearer ${redis.token}`,
  };

  const incrRes = await fetch(`${redis.url}/incr/${encodedKey}`, {
    headers,
    cache: "no-store",
  });
  if (!incrRes.ok) return null;

  const incrJson = await incrRes.json();
  const count = Number(incrJson?.result ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;

  if (count === 1) {
    await fetch(`${redis.url}/expire/${encodedKey}/${ttlSeconds}`, {
      headers,
      cache: "no-store",
    });
  }

  const ttlRes = await fetch(`${redis.url}/ttl/${encodedKey}`, {
    headers,
    cache: "no-store",
  });
  const ttlJson = ttlRes.ok ? await ttlRes.json() : null;
  const ttl = Number(ttlJson?.result ?? ttlSeconds);
  const safeTtlSeconds = ttl > 0 ? ttl : ttlSeconds;

  return {
    allowed: count <= config.max,
    remaining: Math.max(config.max - count, 0),
    resetAt: Date.now() + safeTtlSeconds * 1000,
    limit: config.max,
  };
}

function consumeInMemoryRateLimit(
  key: string,
  config: LimitConfig,
): LimitResult {
  const now = Date.now();
  const current = store.get(key);

  if (!current || now >= current.resetAt) {
    const entry = { count: 1, resetAt: now + config.windowMs };
    store.set(key, entry);
    return {
      allowed: true,
      remaining: config.max - 1,
      resetAt: entry.resetAt,
      limit: config.max,
    };
  }

  current.count += 1;
  store.set(key, current);

  return {
    allowed: current.count <= config.max,
    remaining: Math.max(config.max - current.count, 0),
    resetAt: current.resetAt,
    limit: config.max,
  };
}

export async function consumeRateLimit(
  key: string,
  config: LimitConfig,
): Promise<LimitResult> {
  try {
    const remoteResult = await consumeRemoteRateLimit(key, config);
    if (remoteResult) return remoteResult;
  } catch {
    // Fallback to in-memory limiter if remote store is unavailable.
  }

  return consumeInMemoryRateLimit(key, config);
}

let lastCleanup = 0;
export function cleanupRateLimitStore() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;

  for (const [key, entry] of store.entries()) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}
