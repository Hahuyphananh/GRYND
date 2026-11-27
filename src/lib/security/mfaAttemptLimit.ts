// src/lib/security/mfaAttemptLimit.ts
// Durable MFA attempt throttling to prevent sustained factor guessing.
//
// The generic rate limiter (60 req/min per user) resets every window and is
// not tied to MFA failures. This module tracks failed verification attempts
// per user and enforces progressive lockout:
//   * 5 failed attempts → 5-minute lockout
//   * 10 failed attempts → 30-minute lockout
//   * 15+ failed attempts → 2-hour lockout
//
// Uses Redis when available and falls back to in-memory store (mirroring the
// rate-limit pattern) so the flow still works on a single instance when Redis
// isn't configured.

import { getRedis } from "../redis/client";

/**
 * Which flow a counter belongs to.
 *
 * The keys must not collide: an admin is also a regular user, and guesses
 * against their USER-level factor must not consume (or reset) the admin
 * budget. `admin` keeps the original key prefix, so existing records and
 * lockouts survive this change.
 */
export type MfaAttemptScope = "admin" | "user";

const PREFIX_VERIFY = "-mfa:attempts:";
const PREFIX_SEND = "-mfa:send:";

// Verification attempt limits
const VERIFY_LOCKOUT_THRESHOLDS = [
  { attempts: 5, lockoutMs: 5 * 60 * 1000 },      // 5 failures → 5 min
  { attempts: 10, lockoutMs: 30 * 60 * 1000 },    // 10 failures → 30 min
  { attempts: 15, lockoutMs: 2 * 60 * 60 * 1000 }, // 15+ failures → 2 hours
];

// OTP send limits: max 3 sends per 5 minutes per user
const SEND_MAX_ATTEMPTS = 3;
const SEND_WINDOW_MS = 5 * 60 * 1000;

type AttemptRecord = {
  count: number;
  lockedUntil: number | null;
  firstAttemptAt: number;
};

type SendRecord = {
  count: number;
  windowStart: number;
};

const verifyMemory = new Map<string, AttemptRecord>();
const sendMemory = new Map<string, SendRecord>();

// Serializes read-modify-write per key. Without this, N concurrent failures can
// all read the same count and write count+1, so an attacker who parallelises
// guesses records ONE attempt instead of N. Redis does not save the fallback:
// many deployments run without it, so the queue lives here.
const verifyQueues = new Map<string, Promise<void>>();

function runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = verifyQueues.get(key) ?? Promise.resolve();
  // Run whether or not the previous task settled well, and never let one
  // rejection poison the chain for later attempts.
  const run = previous.then(task, task);
  verifyQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function verifyKey(userId: string, scope: MfaAttemptScope): string {
  return `${scope}${PREFIX_VERIFY}${userId}`;
}

function sendKey(userId: string, scope: MfaAttemptScope): string {
  return `${scope}${PREFIX_SEND}${userId}`;
}

// ── Verification Attempt Tracking ──────────────────────────────────────────

async function readVerifyRecord(
  userId: string,
  scope: MfaAttemptScope,
): Promise<AttemptRecord | null> {
  const key = verifyKey(userId, scope);
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const rec = JSON.parse(String(raw)) as AttemptRecord;
        // Check if lockout has expired
        if (rec.lockedUntil && rec.lockedUntil <= Date.now()) {
          // Lockout expired, reset
          await redis.del(key).catch(() => {});
          return null;
        }
        return rec;
      }
    } catch (err) {
      console.warn("[mfaAttemptLimit] Redis read failed, falling back to memory:", err);
    }
  }

  const rec = verifyMemory.get(key);
  if (rec) {
    if (rec.lockedUntil && rec.lockedUntil <= Date.now()) {
      verifyMemory.delete(key);
      return null;
    }
    return rec;
  }
  return null;
}

async function writeVerifyRecord(
  userId: string,
  scope: MfaAttemptScope,
  record: AttemptRecord,
): Promise<void> {
  const key = verifyKey(userId, scope);
  verifyMemory.set(key, record);

  const redis = getRedis();
  if (redis) {
    // TTL: if locked, expire when lockout ends; otherwise 2 hours
    const ttlMs = record.lockedUntil
      ? Math.max(record.lockedUntil - Date.now(), 60_000)
      : 2 * 60 * 60 * 1000;
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    await redis.set(key, JSON.stringify(record), { ex: ttlSeconds }).catch(() => {});
  }
}

async function deleteVerifyRecord(userId: string, scope: MfaAttemptScope): Promise<void> {
  const key = verifyKey(userId, scope);
  verifyMemory.delete(key);

  const redis = getRedis();
  if (redis) {
    await redis.del(key).catch(() => {});
  }
}

/**
 * Check if the user is currently locked out from MFA verification.
 * Returns { allowed: false, lockedUntil } if locked, { allowed: true } otherwise.
 */
/**
 * Test-only: forget every in-memory attempt record.
 *
 * The limiter keeps its Redis fallback in the two module-level maps below;
 * tests run without Redis configured, so clearing them is the only reset
 * available. Redis state is deliberately NOT touched — a test must never
 * delete production keys.
 */
export function __resetMfaAttemptMemory(): void {
  verifyMemory.clear();
  verifyQueues.clear();
  sendMemory.clear();
}

export async function checkVerifyAttemptLimit(
  userId: string,
  scope: MfaAttemptScope = "admin",
): Promise<{ allowed: boolean; lockedUntil?: number; attempts?: number }> {
  const record = await readVerifyRecord(userId, scope);
  if (!record) {
    return { allowed: true };
  }

  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return { allowed: false, lockedUntil: record.lockedUntil, attempts: record.count };
  }

  return { allowed: true, attempts: record.count };
}

/**
 * Record a failed MFA verification attempt and apply progressive lockout.
 */
export async function recordVerifyFailure(
  userId: string,
  scope: MfaAttemptScope = "admin",
): Promise<void> {
  // One increment per invocation, even under Promise.all: the count is the
  // security property, so concurrent failures must never collapse into one.
  await runExclusive(verifyKey(userId, scope), () =>
    recordVerifyFailureLocked(userId, scope),
  );
}

async function recordVerifyFailureLocked(
  userId: string,
  scope: MfaAttemptScope,
): Promise<void> {
  const now = Date.now();
  const record = await readVerifyRecord(userId, scope);

  const newCount = (record?.count ?? 0) + 1;
  const firstAttemptAt = record?.firstAttemptAt ?? now;

  // Determine lockout based on attempt count
  let lockedUntil: number | null = null;
  for (let i = VERIFY_LOCKOUT_THRESHOLDS.length - 1; i >= 0; i--) {
    const threshold = VERIFY_LOCKOUT_THRESHOLDS[i];
    if (newCount >= threshold.attempts) {
      lockedUntil = now + threshold.lockoutMs;
      break;
    }
  }

  await writeVerifyRecord(userId, scope, {
    count: newCount,
    lockedUntil,
    firstAttemptAt,
  });
}

/**
 * Clear the verification attempt record (called on successful verification).
 */
export async function clearVerifyAttempts(
  userId: string,
  scope: MfaAttemptScope = "admin",
): Promise<void> {
  await deleteVerifyRecord(userId, scope);
}

// ── OTP Send Throttling ────────────────────────────────────────────────────

async function readSendRecord(
  userId: string,
  scope: MfaAttemptScope,
): Promise<SendRecord | null> {
  const key = sendKey(userId, scope);
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const rec = JSON.parse(String(raw)) as SendRecord;
        // Check if window has expired
        if (rec.windowStart + SEND_WINDOW_MS <= Date.now()) {
          await redis.del(key).catch(() => {});
          return null;
        }
        return rec;
      }
    } catch (err) {
      console.warn("[mfaAttemptLimit] Redis read failed, falling back to memory:", err);
    }
  }

  const rec = sendMemory.get(key);
  if (rec) {
    if (rec.windowStart + SEND_WINDOW_MS <= Date.now()) {
      sendMemory.delete(key);
      return null;
    }
    return rec;
  }
  return null;
}

async function writeSendRecord(
  userId: string,
  scope: MfaAttemptScope,
  record: SendRecord,
): Promise<void> {
  const key = sendKey(userId, scope);
  sendMemory.set(key, record);

  const redis = getRedis();
  if (redis) {
    const ttlSeconds = Math.ceil(SEND_WINDOW_MS / 1000);
    await redis.set(key, JSON.stringify(record), { ex: ttlSeconds }).catch(() => {});
  }
}

/**
 * Check if the user can send another OTP (max 3 per 5 minutes).
 * Returns { allowed: false, resetAt } if limit exceeded, { allowed: true } otherwise.
 */
export async function checkSendAttemptLimit(
  userId: string,
  scope: MfaAttemptScope = "admin",
): Promise<{ allowed: boolean; resetAt?: number; remaining?: number }> {
  const record = await readSendRecord(userId, scope);
  if (!record) {
    return { allowed: true, remaining: SEND_MAX_ATTEMPTS };
  }

  if (record.count >= SEND_MAX_ATTEMPTS) {
    return {
      allowed: false,
      resetAt: record.windowStart + SEND_WINDOW_MS,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    remaining: SEND_MAX_ATTEMPTS - record.count,
  };
}

/**
 * Record an OTP send attempt.
 */
export async function recordSendAttempt(
  userId: string,
  scope: MfaAttemptScope = "admin",
): Promise<void> {
  const now = Date.now();
  const record = await readSendRecord(userId, scope);

  if (!record) {
    await writeSendRecord(userId, scope, { count: 1, windowStart: now });
  } else {
    await writeSendRecord(userId, scope, {
      count: record.count + 1,
      windowStart: record.windowStart,
    });
  }
}
