// src/lib/auth/adminOtp.ts
// Short-lived one-time codes for the admin "email" second factor.
// Uses Upstash Redis when available and falls back to an in-memory store
// (mirroring the rate-limit pattern) so the flow still works on a single
// instance when Redis isn't configured.

import crypto from "crypto";
import { getRedis } from "../redis/client";

const OTP_TTL_SECONDS = 5 * 60;
const PREFIX = "admin-mfa:otp:";

type OtpRecord = { hash: string; salt: string; expiresAt: number };

const memory = new Map<string, OtpRecord>();

function recordKey(clerkId: string): string {
  return `${PREFIX}${clerkId}`;
}

function hashCode(code: string, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

async function readRecord(clerkId: string): Promise<OtpRecord | null> {
  const key = recordKey(clerkId);
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const rec = JSON.parse(String(raw)) as OtpRecord;
        if (rec.expiresAt > Date.now()) return rec;
        await redis.del(key).catch(() => {});
        return null;
      }
    } catch (err) {
      console.warn("[adminOtp] Redis read failed, falling back to memory:", err);
    }
  }

  const rec = memory.get(key);
  if (rec && rec.expiresAt > Date.now()) return rec;
  memory.delete(key);
  return null;
}

export async function issueOtp(clerkId: string): Promise<string> {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = crypto.randomBytes(8).toString("hex");
  const record: OtpRecord = {
    hash: hashCode(code, salt),
    salt,
    expiresAt: Date.now() + OTP_TTL_SECONDS * 1000,
  };

  const key = recordKey(clerkId);
  memory.set(key, record);

  const redis = getRedis();
  if (redis) {
    await redis.set(key, JSON.stringify(record), { ex: OTP_TTL_SECONDS }).catch(() => {});
  }

  return code;
}

/** Verify and consume (one-time use) a submitted code. */
export async function verifyOtp(clerkId: string, code: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;

  const record = await readRecord(clerkId);
  if (!record) return false;

  const candidate = Buffer.from(hashCode(code, record.salt), "utf8");
  const expected = Buffer.from(record.hash, "utf8");
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
    return false;
  }

  const key = recordKey(clerkId);
  memory.delete(key);
  const redis = getRedis();
  if (redis) await redis.del(key).catch(() => {});

  return true;
}
