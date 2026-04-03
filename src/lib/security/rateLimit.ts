export type LimitConfig = {
  windowMs: number;
  max: number;
};

type Entry = {
  count: number;
  resetAt: number;
};

const store = new Map<string, Entry>();

export function consumeRateLimit(key: string, config: LimitConfig) {
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
