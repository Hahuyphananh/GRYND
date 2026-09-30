// src/lib/solitaire-duel/seeds.js
//
// The provably-fair seed system behind Solitaire Duel's shared puzzle. Mirrors
// Memory Grid's implementation (`src/lib/memory-grid/seeds.js`), which in turn
// mirrors lane-rush-duel's (`src/lib/laneRunner.js`):
//
//   * a 32-byte random SERVER seed is generated once per match
//     (crypto.randomBytes — never client-supplied)
//   * its SHA-256 hash is committed to the match row BEFORE play, so the deal
//     is fixed and verifiable from the moment the row exists
//   * the deal seed is a SHA-256 digest of
//     `${serverSeed}:variant:${variantVersion}` truncated to a 32-bit unsigned
//     int — ONE derivation, so both seats provably reconstruct the exact same
//     deck, and nobody can reconstruct it pre-match without the server seed
//     (SHA-256 preimage resistance). The match id is deliberately NOT an input:
//     the server seed is already unique to the match, and leaving it out means
//     a developer can rebuild the exact deal from the stored seed ALONE.
//   * the raw server seed is revealed only when the match is terminal, so
//     either player can verify the deal was the committed one
//
// There is deliberately NO per-player seed: both seats are dealt from this one
// deal seed, which is the entire fairness claim of the game.
//
// SERVER-ONLY MODULE: it imports Node's `crypto`, so it must never be imported
// from a client component. The client-safe pieces (`./deck.ts`, `./rules.ts`)
// import nothing from here; they accept an already-derived numeric seed.

import crypto from "crypto";

/** Random hex string from a cryptographically-secure PRNG — the match seed. */
export function randomHex(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

/**
 * SHA-256 hex digest of the server seed — the pre-match commitment.
 *
 * Shown to both clients before they play, so the post-match seed reveal can be
 * verified: if the revealed seed hashes to the committed value, the deal that
 * was played is the deal that was fixed at match creation.
 */
export function getServerSeedHash(serverSeed) {
  return crypto.createHash("sha256").update(String(serverSeed)).digest("hex");
}

/**
 * Deterministic 32-bit deal seed.
 *
 * Both seats derive their board from this one value, and the variant version is
 * part of the digest input, so a future ruleset change can never reinterpret an
 * existing match's stored deal as a different deck.
 *
 * The match id is deliberately NOT an input: the server seed is already unique
 * to the match, and leaving it out means the exact deal can be rebuilt from the
 * stored seed ALONE (which is what the post-match reveal promises).
 *
 * @param {object} opts
 * @param {string} opts.serverSeed       the match's random server seed
 * @param {number} [opts.variantVersion] the frozen ruleset version
 * @returns {number} unsigned 32-bit int seed for `dealFromSeed`
 */
export function deriveDealSeed({ serverSeed, variantVersion = 1 }) {
  const digest = crypto
    .createHash("sha256")
    .update(`${serverSeed}:variant:${variantVersion}`)
    .digest("hex");
  // First 8 hex chars → 32-bit unsigned int. `>>> 0` keeps it positive for
  // mulberry32 (the same coercion the platform's `hashSeed` uses).
  return parseInt(digest.slice(0, 8), 16) >>> 0;
}

/** The reveal check a client (or a test) runs post-match. */
export function verifyDealSeed({ serverSeed, variantVersion = 1, dealSeed }) {
  return deriveDealSeed({ serverSeed, variantVersion }) === Number(dealSeed);
}
