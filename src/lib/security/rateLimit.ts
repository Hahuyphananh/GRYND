export type LimitConfig = {
  windowMs: number;
  max: number;
};

type Entry = {
  count: number;
  resetAt: number;
};

type ConsumeResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
};

const store = new Map<string, Entry>();

function consumeInMemory(key: string, config: LimitConfig): ConsumeResult {
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

async function consumeUpstash(key: string, config: LimitConfig): Promise<ConsumeResult | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const encodedKey = encodeURIComponent(`ratelimit:${key}`);
    const headers = { Authorization: `Bearer ${token}` };

    const incrRes = await fetch(`${url}/incr/${encodedKey}`, { headers, cache: 'no-store' });
    if (!incrRes.ok) return null;
    const incrData = await incrRes.json();
    const count = Number(incrData.result ?? 0);

    if (count === 1) {
      await fetch(`${url}/pexpire/${encodedKey}/${config.windowMs}`, { headers, cache: 'no-store' });
    }

    const ttlRes = await fetch(`${url}/pttl/${encodedKey}`, { headers, cache: 'no-store' });
    const ttlData = ttlRes.ok ? await ttlRes.json() : { result: config.windowMs };
    const ttlMs = Math.max(Number(ttlData.result ?? config.windowMs), 0);

    return {
      allowed: count <= config.max,
      remaining: Math.max(config.max - count, 0),
      resetAt: Date.now() + ttlMs,
      limit: config.max,
    };
  } catch {
    return null;
  }
}

export async function consumeRateLimit(key: string, config: LimitConfig): Promise<ConsumeResult> {
  const distributed = await consumeUpstash(key, config);
  if (distributed) return distributed;
  return consumeInMemory(key, config);
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
