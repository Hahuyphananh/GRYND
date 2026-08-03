/**
 * Crash Arena — Crash Point Generator
 *
 * Deterministically derives the crash multiplier from a round seed.
 * Given the same seed, the same crash point is always produced.
 * This is the server-authoritative source of truth — the client
 * never decides the crash point.
 *
 * Pattern follows laneRunner.js: SHA-256 → first 13 hex chars → float.
 */
import crypto from "node:crypto";
import { CRASH_MIN, CRASH_RANGE } from "./constants";

/** Maximum value of a 13-hex-digit number (0x1fffffffffffff). */
const MAX_ROLL = 0x1fffffffffffff;

/**
 * Convert a SHA-256 digest into a float in [0, 1).
 * Uses the first 13 hex chars — same approach as laneRunner.js.
 */
function digestToFloat(digest: string): number {
  return parseInt(digest.slice(0, 13), 16) / MAX_ROLL;
}

/**
 * Generate a deterministic crash point from a seed.
 *
 * Algorithm:
 *   1. SHA-256(seed) → 64-char hex digest
 *   2. First 13 chars → integer → divide by MAX_ROLL → float in [0, 1)
 *   3. Map to [CRASH_MIN, CRASH_MAX] and round to 2 decimal places
 *
 * @param seed  The round seed (from generateRoundSeed)
 * @returns     Crash multiplier (e.g., 3.47)
 */
export function generateCrashPoint(seed: string): number {
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  const roll = digestToFloat(digest);
  const crashPoint = CRASH_MIN + roll * CRASH_RANGE;
  return Number(crashPoint.toFixed(2));
}

/**
 * Generate a crash point along with verification data.
 * Returns everything a client needs to independently verify the result.
 *
 * @param seed  The round seed
 * @returns     { crashPoint, digest, roll, seed }
 */
export function generateVerifiableCrashPoint(seed: string) {
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  const roll = digestToFloat(digest);
  const crashPoint = Number((CRASH_MIN + roll * CRASH_RANGE).toFixed(2));

  return {
    crashPoint,
    /** SHA-256 digest of the seed (64 hex chars). */
    digest,
    /** The raw float roll in [0, 1) before mapping. */
    roll: Number(roll.toFixed(8)),
    seed,
  };
}

/**
 * Client-side verification (can be used in browser via Web Crypto API).
 *
 * Call this after the round ends: pass the revealed seed and the
 * crash point that was used during the round. Returns true if the
 * crash point was honestly derived from the seed.
 *
 * Note: this function is designed to work both server-side (Node crypto)
 * and client-side (if you shim or use SubtleCrypto). For now it imports
 * Node crypto; a browser-compatible version would use SubtleCrypto.
 */
export function verifyCrashPoint(seed: string, expectedCrashPoint: number): boolean {
  const actual = generateCrashPoint(seed);
  return actual === expectedCrashPoint;
}
