// src/lib/memory-grid/seeds.js
//
// Deterministic, server-authoritative challenge seeds for Memory Grid.
// Mirrors lane-rush-duel's provably-fair seed system (see
// `src/lib/laneRunner.js` + `src/lib/lane-rush-duel/constants.js`):
//
//   * a 32-byte random SERVER seed is generated per match at creation
//     (crypto.randomBytes — never client-supplied)
//   * its SHA-256 hash is committed to the match row pre-match
//   * every round's pattern seed is derived via a SHA-256 digest of
//     `${serverSeed}:${matchId}:round:${roundNumber}` truncated to a
//     32-bit unsigned int — the SAME derivation for both players, so
//     both provably reconstruct the exact same grid pattern
//   * the raw server seed is revealed post-match (hash → seed
//     verification), exactly like lane-rush-duel
//
// Because the pattern is SHARED between both players (one `board`
// per round), there are no per-player client seeds — the shared
// server seed + round number fully determine the challenge.
//
// SERVER-ONLY MODULE: it imports Node's `crypto`, so it must never
// be imported from a client component. `constants.js` (which the
// lobby + match views import) stays crypto-free; the seeded pattern
// generator there accepts an already-derived 32-bit seed.

import crypto from "crypto";

/** Random hex string from a cryptographically-secure PRNG. Mirrors
 *  `src/lib/laneRunner.js`'s `randomHex` — the match's server seed. */
export function randomHex(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

/** SHA-256 hex digest of the server seed — the pre-match commitment.
 *  Shown to clients before the match so the post-match seed reveal
 *  can be verified (mirrors lane-rush-duel's `getServerSeedHash`). */
export function getServerSeedHash(serverSeed) {
  return crypto.createHash("sha256").update(serverSeed).digest("hex");
}

/**
 * Deterministic 32-bit pattern seed for a specific round of a match.
 *
 * Both players' grids for round N derive from the SAME digest input
 * (`${serverSeed}:${matchId}:round:${roundNumber}`), so both players
 * are guaranteed the exact same pattern — nobody can independently
 * generate a different one, and nobody can reconstruct the pattern
 * pre-match without the server seed (SHA-256 preimage resistance).
 *
 * @param {object} opts
 * @param {string} opts.serverSeed The match's random server seed.
 * @param {number|string} opts.matchId The match id (serial) as nonce.
 * @param {number} opts.roundNumber 1..ROUNDS_PER_MATCH.
 * @returns {number} unsigned 32-bit int seed for generatePattern.
 */
export function derivePatternSeed({ serverSeed, matchId, roundNumber }) {
  const digest = crypto
    .createHash("sha256")
    .update(`${serverSeed}:${matchId}:round:${roundNumber}`)
    .digest("hex");
  // First 8 hex chars → 32-bit unsigned int. `>>> 0` keeps it
  // positive for mulberry32 (same coercion as plinko-pvp's hashSeed).
  return parseInt(digest.slice(0, 8), 16) >>> 0;
}
