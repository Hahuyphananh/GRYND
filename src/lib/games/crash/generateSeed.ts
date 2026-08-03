/**
 * Crash Arena — Round Seed Generator
 *
 * Generates a cryptographically secure random seed for each round.
 * The server reveals the seed hash before the round (commitment) and
 * the seed after the round (reveal), so players can verify the crash
 * point was not manipulated.
 *
 * Pattern follows laneRunner.js / goonbet-clicker-db.ts conventions.
 */
import crypto from "node:crypto";

export interface RoundSeed {
  /** The raw seed used to derive the crash point (kept secret until after the round). */
  seed: string;
  /** SHA-256 hash of the seed — published before the round starts. */
  hash: string;
  /** When the seed was generated (ISO 8601). */
  generatedAt: string;
}

/**
 * Generate a new round seed and its commitment hash.
 *
 * @param byteLength  Number of random bytes (default 32 → 64 hex chars)
 * @returns           { seed, hash, generatedAt }
 */
export function generateRoundSeed(byteLength = 32): RoundSeed {
  const seed = crypto.randomBytes(byteLength).toString("hex");
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const generatedAt = new Date().toISOString();

  return { seed, hash, generatedAt };
}

/**
 * Verify that a seed matches its previously published hash.
 * Players call this after the round to confirm fairness.
 */
export function verifySeed(seed: string, expectedHash: string): boolean {
  const computed = crypto.createHash("sha256").update(seed).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(expectedHash, "hex"),
  );
}
