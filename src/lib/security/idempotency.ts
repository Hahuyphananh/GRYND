type Seen = { expiresAt: number };

const seen = new Map<string, Seen>();

function readIdempotencyKey(req: Request) {
  const key = req.headers.get("idempotency-key");
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length >= 8 && trimmed.length <= 128 ? trimmed : null;
}

async function setNxUpstash(
  scope: string,
  key: string,
  ttlSeconds: number,
): Promise<boolean | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  try {
    const redisKey = encodeURIComponent(`idem:${scope}:${key}`);
    const headers = { Authorization: `Bearer ${token}` };
    const res = await fetch(`${url}/set/${redisKey}/1/NX/EX/${ttlSeconds}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result === "OK";
  } catch {
    return null;
  }
}

function setNxMemory(scope: string, key: string, ttlMs: number) {
  const now = Date.now();
  const storageKey = `${scope}:${key}`;
  const existing = seen.get(storageKey);
  if (existing && existing.expiresAt > now) return false;
  seen.set(storageKey, { expiresAt: now + ttlMs });
  return true;
}

export async function claimIdempotency(
  req: Request,
  scope: string,
  ttlSeconds = 120,
) {
  const key = readIdempotencyKey(req);
  if (!key) return { enforced: false, allowed: true };

  const upstash = await setNxUpstash(scope, key, ttlSeconds);
  if (upstash !== null) {
    return { enforced: true, allowed: upstash };
  }

  const allowed = setNxMemory(scope, key, ttlSeconds * 1000);
  return { enforced: true, allowed };
}
